"""Markdown section-based editing utilities."""

from __future__ import annotations

from datetime import date
import logging
import re
from typing import Literal

logger = logging.getLogger(__name__)

try:
    from pydantic import BaseModel
except ModuleNotFoundError:

    class BaseModel:
        """Minimal fallback used when pydantic is unavailable."""

        def __init__(self, **data):
            for key, value in data.items():
                setattr(self, key, value)
            for key, value in self.__class__.__dict__.items():
                if key.startswith("_"):
                    continue
                if callable(value) or isinstance(value, property):
                    continue
                if key not in self.__dict__:
                    setattr(self, key, value)

        def model_copy(self, deep: bool = False):
            copied = {}
            for key, value in self.__dict__.items():
                if deep and isinstance(value, list):
                    copied[key] = list(value)
                elif deep and isinstance(value, dict):
                    copied[key] = dict(value)
                else:
                    copied[key] = value
            return self.__class__(**copied)


class SectionEdit(BaseModel):
    action: Literal["replace_section", "append_to", "add_section"]
    heading_path: str | None = None
    parent_heading_path: str | None = None
    new_heading: str | None = None
    content: str


class MarkdownSectionEditor:
    """Helper to edit Markdown sections using heading paths as anchors."""

    def __init__(self, content: str):
        self.lines = content.split("\n")

    def find_section(self, heading_path: str) -> tuple[int, int] | None:
        """Find line indices of a section. Returns (start_idx, end_idx) or None."""
        path_parts = [p.strip() for p in heading_path.split(">")]
        current_idx = 0
        start_idx = -1

        for part in path_parts:
            found = False
            for i in range(current_idx, len(self.lines)):
                if self.lines[i].strip() == part:
                    current_idx = i
                    start_idx = i
                    found = True
                    break
            if not found:
                return None

        if start_idx == -1:
            return None

        # Determine level of the leaf heading
        m = re.match(r"^(#+)", path_parts[-1])
        level = len(m.group(1)) if m else 0

        end_idx = len(self.lines) - 1
        for i in range(start_idx + 1, len(self.lines)):
            line = self.lines[i].strip()
            if line.startswith("#"):
                m_inner = re.match(r"^(#+)", line)
                if m_inner and len(m_inner.group(1)) <= level:
                    end_idx = i - 1
                    break
        return (start_idx, end_idx)

    def replace_section(self, heading_path: str, content: str) -> bool:
        r = self.find_section(heading_path)
        if not r:
            return False
        start, end = r
        self.lines[start + 1 : end + 1] = content.split("\n")
        return True

    def append_to_section(self, heading_path: str, content: str) -> bool:
        r = self.find_section(heading_path)
        if not r:
            return False
        _, end = r
        new_lines = content.split("\n")
        # Ensure there's a blank line before appending if the section is not empty
        if end > 0 and self.lines[end].strip() != "" and new_lines:
            self.lines.insert(end + 1, "")
            end += 1
        self.lines[end + 1 : end + 1] = new_lines
        return True

    def add_section(self, parent_path: str, new_heading: str, content: str) -> bool:
        r = self.find_section(parent_path)
        if not r:
            return False
        _, end = r
        new_sec = [new_heading] + content.split("\n")
        self.lines[end + 1 : end + 1] = ["", ""] + new_sec
        return True

    def get_content(self) -> str:
        return "\n".join(self.lines)


def strip_code_blocks(content: str) -> str:
    """Remove Markdown code blocks (```...```) from the content."""
    return re.sub(r"```.*?```", "", content, flags=re.DOTALL).strip()


def filter_attachment_footnotes(content: str) -> str:
    """Remove footnotes that point to non-markdown attachments (e.g. .pdf, .docx)."""
    # Footnote definitions look like [^1]: [[(안전성검토)_파일명.pdf]]
    # We want to remove lines like [^1]: [[...]] where the link contains .pdf, .docx, etc.
    lines = content.split("\n")
    new_lines = []
    attachment_patterns = [".pdf", ".docx", ".xlsx", ".pptx", ".hwp"]

    removed_footnote_ids = set()

    for line in lines:
        m = re.match(r"^\[\^(\d+)\]:\s*\[\[(.*?)\]\]", line)
        if m:
            fn_id = m.group(1)
            target = m.group(2)
            if any(ext in target.lower() for ext in attachment_patterns):
                removed_footnote_ids.add(fn_id)
                continue
        new_lines.append(line)

    # Also remove references in text [^1] if they were removed
    result = "\n".join(new_lines)
    for fn_id in removed_footnote_ids:
        result = result.replace(f"[^{fn_id}]", "")

    return result


def merge_missing_footnote_definitions(current: str, reference: str) -> str:
    used_ids = set(re.findall(r"\[\^([^\]]+)\]", current))
    if not used_ids:
        return current

    def _parse_defs(text: str) -> dict[str, str]:
        defs: dict[str, str] = {}
        for line in text.split("\n"):
            m = re.match(r"^\[\^([^\]]+)\]:\s*(.*)$", line)
            if m:
                defs[m.group(1)] = m.group(2).strip()
        return defs

    current_defs = _parse_defs(current)
    ref_defs = _parse_defs(reference)
    missing = [
        fid for fid in sorted(used_ids) if fid not in current_defs and fid in ref_defs
    ]
    if not missing:
        return current

    lines = current.rstrip().split("\n")
    if lines and lines[-1].strip():
        lines.append("")
    for fid in missing:
        lines.append(f"[^{fid}]: {ref_defs[fid]}")
    return "\n".join(lines) + "\n"


def _normalize_footnote_target(target: str) -> str:
    """Normalize a footnote definition body for dedup comparison.

    Strips surrounding whitespace, removes Obsidian wiki-link brackets,
    and collapses internal whitespace so that equivalent targets written
    slightly differently still hash to the same key.
    """
    t = (target or "").strip()
    t = re.sub(r"^\[\[\(?", "", t)
    t = re.sub(r"\)?\]\]$", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.casefold()


def dedup_footnotes_by_source(content: str) -> str:
    """Collapse footnotes that point to the same source document.

    Compose and revise LLM passes assign a fresh ``[^N]`` to every claim
    even when multiple claims cite the exact same document. This function
    groups definitions by normalized target text and collapses each group
    to its lowest-numbered id. Body references are rewritten accordingly,
    duplicate consecutive references in the same bracket chain are merged,
    and unused definitions are dropped.

    Only numeric ids are touched; named ids (``[^note]``) and orphaned
    references with no matching definition are left alone.
    """
    lines = content.split("\n")
    # Collect definitions preserving first-appearance order.
    def_order: list[str] = []
    def_map: dict[str, str] = {}
    def_lines: set[int] = set()
    for idx, line in enumerate(lines):
        m = re.match(r"^\[\^([^\]]+)\]:\s*(.*)$", line)
        if not m:
            continue
        fid = m.group(1)
        body = m.group(2).strip()
        if fid not in def_map:
            def_order.append(fid)
            def_map[fid] = body
        def_lines.add(idx)

    if not def_map:
        return content

    # Group ids by normalized target.
    groups: dict[str, list[str]] = {}
    for fid in def_order:
        key = _normalize_footnote_target(def_map[fid])
        if not key:
            continue
        groups.setdefault(key, []).append(fid)

    # Build replacement map using the lowest id in each group as canonical.
    # For numeric ids we pick the numerically smallest; for mixed ids we
    # preserve insertion order.
    replacements: dict[str, str] = {}
    canonical_ids: set[str] = set()

    def _id_sort_key(fid: str):
        return (0, int(fid)) if fid.isdigit() else (1, fid)

    for key, ids in groups.items():
        canonical = sorted(ids, key=_id_sort_key)[0]
        canonical_ids.add(canonical)
        for fid in ids:
            if fid != canonical:
                replacements[fid] = canonical

    if not replacements:
        return content

    # Rewrite body references: turn `[^N]` into `[^canonical]`. Applied to
    # non-definition lines only so we don't accidentally overwrite the
    # definition line we're about to remove.
    rewritten: list[str] = []
    for idx, line in enumerate(lines):
        if idx in def_lines:
            rewritten.append(line)
            continue
        def _sub(m: re.Match) -> str:
            fid = m.group(1)
            return f"[^{replacements.get(fid, fid)}]"

        rewritten.append(re.sub(r"\[\^([^\]]+)\]", _sub, line))

    # Collapse consecutive duplicate references like `[^1][^1]` → `[^1]` and
    # repeated blocks like `[^1][^2][^1]` → `[^1][^2]` (dedup within a run).
    def _collapse(line: str) -> str:
        def _dedup_run(m: re.Match) -> str:
            run = m.group(0)
            refs = re.findall(r"\[\^([^\]]+)\]", run)
            seen: list[str] = []
            for r in refs:
                if r not in seen:
                    seen.append(r)
            return "".join(f"[^{r}]" for r in seen)

        return re.sub(r"(?:\[\^[^\]]+\]){2,}", _dedup_run, line)

    rewritten = [_collapse(line) for line in rewritten]

    # Drop duplicate definition lines. Keep only the canonical definition
    # for each group, in first-appearance order.
    final_lines: list[str] = []
    kept_ids: set[str] = set()
    for idx, line in enumerate(rewritten):
        if idx not in def_lines:
            final_lines.append(line)
            continue
        m = re.match(r"^\[\^([^\]]+)\]:\s*", line)
        if not m:
            final_lines.append(line)
            continue
        fid = m.group(1)
        if fid in replacements:
            continue
        if fid in kept_ids:
            continue
        kept_ids.add(fid)
        final_lines.append(line)

    deduped = "\n".join(final_lines)
    deduped = re.sub(r"\n{3,}", "\n\n", deduped)

    # Sequential renumbering: after dedup we may have sparse ids like
    # [^1],[^14],[^23]. Walk the body top-to-bottom to determine the
    # first-appearance order of each numeric canonical id and remap them
    # to 1..N. Non-numeric ids are left alone.
    numeric_canonical = sorted(
        (fid for fid in canonical_ids if fid.isdigit()), key=lambda x: int(x)
    )
    first_seen_order: list[str] = []
    for line in deduped.split("\n"):
        if line.lstrip().startswith("[^") and re.match(
            r"^\s*\[\^[^\]]+\]:", line
        ):
            continue
        for ref in re.findall(r"\[\^(\d+)\]", line):
            if ref in numeric_canonical and ref not in first_seen_order:
                first_seen_order.append(ref)
    # Append any canonical ids that appear only in definitions (no body use).
    for fid in numeric_canonical:
        if fid not in first_seen_order:
            first_seen_order.append(fid)

    renumber: dict[str, str] = {}
    for new_idx, old_id in enumerate(first_seen_order, start=1):
        if str(new_idx) != old_id:
            renumber[old_id] = str(new_idx)

    if not renumber:
        return deduped

    # Apply the renumbering to both references and definitions. Use a
    # sentinel-based two-pass swap so that `[^1] → [^2]` and `[^2] → [^1]`
    # don't clobber each other.
    result_lines: list[str] = []
    for line in deduped.split("\n"):
        def _to_sentinel(m: re.Match) -> str:
            fid = m.group(1)
            if fid in renumber:
                return f"[^§§{renumber[fid]}§§]"
            return m.group(0)

        def _def_to_sentinel(m: re.Match) -> str:
            fid = m.group(1)
            if fid in renumber:
                return f"[^§§{renumber[fid]}§§]:"
            return m.group(0)

        line = re.sub(r"^\s*\[\^(\d+)\]:", _def_to_sentinel, line)
        line = re.sub(r"\[\^(\d+)\]", _to_sentinel, line)
        result_lines.append(line)

    result = "\n".join(result_lines)
    result = result.replace("§§", "")
    return result


def apply_generated_frontmatter(
    content: str, *, domain: str, filter_expr: str | None
) -> str:
    metadata: dict[str, object] = {
        "작성일": date.today().isoformat(),
        "domain": domain,
    }
    for field, value in _extract_filter_pairs(filter_expr):
        existing = metadata.get(field)
        if existing is None:
            metadata[field] = value
        elif isinstance(existing, list):
            if value not in existing:
                existing.append(value)
        elif existing != value:
            metadata[field] = [existing, value]

    body_lines = content.split("\n")
    if body_lines and body_lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(body_lines)):
            if body_lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is not None:
            body_lines = body_lines[end_idx + 1 :]

    frontmatter_lines = ["---"]
    for key, value in metadata.items():
        if isinstance(value, list):
            frontmatter_lines.append(f"{key}:")
            for item in value:
                frontmatter_lines.append(f"  - {item}")
        else:
            frontmatter_lines.append(f"{key}: {value}")
    frontmatter_lines.append("---")

    body = "\n".join(body_lines).lstrip("\n")
    return "\n".join(frontmatter_lines) + "\n\n" + body


def _extract_filter_pairs(filter_expr: str | None) -> list[tuple[str, str]]:
    if not filter_expr:
        return []
    return re.findall(r'([A-Za-z0-9_가-힣]+)\s*=\s*"([^"]+)"', filter_expr)


def normalize_wikilink_footnote_targets(content: str) -> str:
    lines: list[str] = []
    for line in content.split("\n"):
        if re.match(r"^\[\^[^\]]+\]:\s*\[\[.*#.*\]\]$", line):
            line = re.sub(
                r"^(\[\^[^\]]+\]:\s*\[\[)(.*?)(#.*)(\]\])$",
                r"\1\2\4",
                line,
            )
        lines.append(line)
    return "\n".join(lines)


def canonicalize_regulation_markdown(
    content: str, allowed_headings: list[str] | None = None
) -> str:
    """Rebuild a regulation wiki into its canonical heading tree.

    Levels match the spec structure (tobacco_regulation.json):
      h1 (#)  — top section: 규제 환경 요약 / 첨가물정보제출 / 분석결과제출 / 제품 규격 및 준수사항
      h2 (##) — submission type: 규제 요건 / 신규제출 / 변경제출 / 정기제출
                                  OR product category: 담배 원료 / 담배 외 원료 및 재료 / 담배 제품
      h3 (###) — sub-detail: 제출 시기 / 제출 대상 및 자료 / 제출 방법

    Previously this function used a level-off-by-one scheme (h2/h3/h4)
    which disagreed with the spec and produced duplicate "wrapper"
    headings in the output. Now it is spec-aligned.
    """
    lines = content.split("\n")
    allowed_titles = None
    if allowed_headings:
        allowed_titles = {
            re.sub(r"^#+\s+", "", h).strip() for h in allowed_headings if h.strip()
        }

    def _normalize_line(line: str) -> str | None:
        stripped = line.strip()

        if re.match(r"^\s*[-*]?\s*(법규|실무|제출 범위):\s*$", line):
            return None

        double_bullet = re.match(r"^\s*[-*]\s+[-*]\s+(.*)$", line)
        if double_bullet:
            return f"    - {double_bullet.group(1).lstrip()}"

        if re.search(r"실무상 .*하면 된다|실무상 준비사항|가장 직접적이다", stripped):
            return None

        if "참고 포인트로 볼 수 있다" in stripped:
            return None

        if re.search(
            r"(명시적으로 )?확인되지 않는다|별도 .* 확인되지 않는다|규정은 확인되지 않는다",
            stripped,
        ):
            return "해당 없음 (근거 문서 없음)"

        spaced_bullet = re.match(r"^(\s*[-*])\s{2,}(.*)$", line)
        if spaced_bullet:
            return f"{spaced_bullet.group(1)} {spaced_bullet.group(2).lstrip()}"

        embedded_heading = re.match(r"^(\s*)(?:[-*]|\d+\.)\s+(#{1,6})\s+(.*)$", line)
        if embedded_heading:
            indent = embedded_heading.group(1)
            label = embedded_heading.group(3).strip()
            return f"{indent}- **{label}**"

        ordered_label = re.match(r"^(\s*)\d+\.\s+(\*\*.+\*\*:?)(.*)$", line)
        if ordered_label:
            indent = ordered_label.group(1)
            label = ordered_label.group(2).strip()
            rest = ordered_label.group(3).rstrip()
            space = " " if rest and not rest.startswith(" ") else ""
            return f"{indent}- {label}{space}{rest.lstrip()}"

        # Accept headings at any level (h1-h4). Unknown titles demote to bullets.
        heading_match = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading_match and allowed_titles is not None:
            title = heading_match.group(2).strip()
            if title not in allowed_titles:
                return f"- **{title}**"

        return line

    h1_order = [
        "규제 환경 요약",
        "첨가물정보제출",
        "분석결과제출",
        "제품 규격 및 준수사항",
    ]
    h1_aliases = {
        "첨가물정보제출": [r"(성분|첨가물).*(제출|정보)"],
        "분석결과제출": [r"(분석결과|배출측정|시험기관|시험실)"],
        "제품 규격 및 준수사항": [r"제품 규격"],
    }

    frontmatter: list[str] = []
    body_lines = lines
    if lines and lines[0].strip() == "---":
        frontmatter.append(lines[0])
        idx = 1
        while idx < len(lines):
            frontmatter.append(lines[idx])
            if lines[idx].strip() == "---":
                idx += 1
                break
            idx += 1
        body_lines = lines[idx:]

    sections: dict[str, list[str]] = {h: [] for h in h1_order}
    current_h1 = h1_order[0]
    # Footnote definitions are hoisted out of section content and
    # re-emitted at the end of the document. This prevents canonical
    # section rebuilding from scattering `[^N]: target` lines into
    # random product sections.
    footnote_defs: list[str] = []

    for raw in body_lines:
        line = _normalize_line(raw)
        if line is None:
            continue
        stripped = line.strip()

        if re.match(r"^\[\^[^\]]+\]:\s*", stripped):
            footnote_defs.append(stripped)
            continue

        # Match the canonical h1 top section. Also accept stray h2-wrappers
        # that carry the exact same title (LLM sometimes emits both h1 and
        # a duplicate h2 with the same text). Both are treated as section
        # boundaries into the same canonical h1 bucket.
        heading_top = re.match(r"^(#{1,2})\s+(.*)$", stripped)
        if heading_top:
            title = heading_top.group(2).strip()
            if title in sections:
                current_h1 = title
                continue

        alias_hit = re.match(r"^-\s+\*\*(.+?)\*\*(?::\s*.*)?$", stripped)
        if alias_hit:
            label = alias_hit.group(1).strip()
            matched_h1 = None
            for h1, patterns in h1_aliases.items():
                if any(re.search(pattern, label) for pattern in patterns):
                    matched_h1 = h1
                    break
            if matched_h1:
                current_h1 = matched_h1
                continue

        sections[current_h1].append(line)

    def _merge_submission_section(section_lines: list[str]) -> list[str]:
        h2_order = ["규제 요건", "신규제출", "변경제출", "정기제출"]
        h3_order = ["제출 시기", "제출 대상 및 자료", "제출 방법"]
        h2_map: dict[str, list[str]] = {k: [] for k in h2_order}
        # Start unassigned so content before the first known h2 falls into
        # 규제 요건 (the most common "overview" bucket) without being mixed
        # with content under other subsections.
        current_h2 = "규제 요건"
        current_h3: str | None = None
        nested: dict[tuple[str, str], list[str]] = {
            (h2, h3): [] for h2 in h2_order for h3 in h3_order
        }

        for line in section_lines:
            stripped = line.strip()
            # Accept either ## or ### to carry the submission type title
            # (revisers sometimes shift levels). Normalize to h2.
            h2_match = re.match(r"^#{2,3}\s+(.*)$", stripped)
            if h2_match and h2_match.group(1).strip() in h2_order:
                current_h2 = h2_match.group(1).strip()
                current_h3 = None
                continue
            # Accept h3 or h4 for sub-detail titles.
            h3_match = re.match(r"^#{3,4}\s+(.*)$", stripped)
            if h3_match and h3_match.group(1).strip() in h3_order:
                current_h3 = h3_match.group(1).strip()
                continue
            if current_h3 and current_h2 in {"신규제출", "변경제출", "정기제출"}:
                nested[(current_h2, current_h3)].append(line)
            else:
                h2_map[current_h2].append(line)

        merged: list[str] = []
        for h2 in h2_order:
            merged.append(f"## {h2}")
            if h2_map[h2]:
                merged.extend(h2_map[h2])
            # Always emit the canonical h3 scaffold for submission types,
            # even if the subsection has no grounded content. This matches
            # the spec tree and lets the reader trust navigation; empty
            # sections are acceptable per the project's "source-grounded
            # coverage, no padding" policy.
            if h2 in {"신규제출", "변경제출", "정기제출"}:
                for h3 in h3_order:
                    merged.append(f"### {h3}")
                    if not nested[(h2, h3)]:
                        continue
                    active_label = False
                    for item in nested[(h2, h3)]:
                        stripped = item.strip()
                        if re.match(r"^- \*\*.+\*\*:?$", stripped):
                            active_label = True
                            merged.append(item)
                            continue
                        if active_label and stripped.startswith("- "):
                            merged.append(f"    {stripped}")
                            continue
                        merged.append(item)
        return merged

    def _merge_product_section(section_lines: list[str]) -> list[str]:
        h2_order = [
            "담배 원료 (tobacco)",
            "담배 외 원료 및 재료 (other than tobacco)",
            "담배 제품 (tobacco products)",
        ]
        h2_map: dict[str, list[str]] = {k: [] for k in h2_order}
        current_h2 = "담배 제품 (tobacco products)"

        for line in section_lines:
            stripped = line.strip()
            # Accept ## or ### to carry the product category title.
            h2_match = re.match(r"^#{2,3}\s+(.*)$", stripped)
            if h2_match and h2_match.group(1).strip() in h2_order:
                current_h2 = h2_match.group(1).strip()
                continue
            h2_map[current_h2].append(line)

        merged: list[str] = []
        for h2 in h2_order:
            merged.append(f"## {h2}")
            merged.extend(h2_map[h2])
        return merged

    rebuilt: list[str] = []
    if frontmatter:
        rebuilt.extend(frontmatter)
        rebuilt.append("")

    for h1 in h1_order:
        rebuilt.append(f"# {h1}")
        section_lines = sections[h1]
        if h1 in {"첨가물정보제출", "분석결과제출"}:
            rebuilt.extend(_merge_submission_section(section_lines))
        elif h1 == "제품 규격 및 준수사항":
            rebuilt.extend(_merge_product_section(section_lines))
        else:
            rebuilt.extend(section_lines)
        if rebuilt and rebuilt[-1] != "":
            rebuilt.append("")

    # Footnote definitions, hoisted out of section content, are re-emitted
    # at the very end in first-appearance order. Duplicates are left for
    # the downstream `dedup_footnotes_by_source` pass to collapse.
    if footnote_defs:
        if rebuilt and rebuilt[-1] != "":
            rebuilt.append("")
        rebuilt.extend(footnote_defs)

    def _repair_product_label_nesting(lines: list[str]) -> list[str]:
        fixed: list[str] = []
        in_submission_materials = False
        active_label = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("### "):
                in_submission_materials = stripped == "### 제출 대상 및 자료"
                active_label = False
                fixed.append(line)
                continue
            if stripped.startswith("## ") or stripped.startswith("# "):
                in_submission_materials = False
                active_label = False
                fixed.append(line)
                continue
            if in_submission_materials and re.match(r"^- \*\*.+\*\*.*$", stripped):
                active_label = True
                fixed.append(stripped)
                continue
            if in_submission_materials and active_label and stripped.startswith("- "):
                fixed.append(f"    {stripped}")
                continue
            fixed.append(line)
        return fixed

    rebuilt = _repair_product_label_nesting(rebuilt)

    # Safety net: convert orphan paragraph lines inside content sections
    # to bullets. LLM sometimes emits narrative prose directly under a
    # heading instead of a `- ...` bullet. The wiki format requires every
    # substantive content block to be a bullet so Citation Ratio and
    # readability behave predictably. We skip frontmatter, blank lines,
    # headings, footnote defs, existing bullets/numbered lists, and the
    # canonical empty marker.
    def _is_already_structured(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return True
        if stripped == "---":
            return True
        if stripped.startswith("#"):
            return True
        if re.match(r"^\s*(?:[-*+]|\d+\.)\s+", line):
            return True
        if re.match(r"^\s*\[\^[^\]]+\]:", stripped):
            return True
        if stripped == "해당 없음 (근거 문서 없음)":
            return True
        return False

    in_frontmatter = False
    bulletized: list[str] = []
    for line in rebuilt:
        if line.strip() == "---":
            in_frontmatter = not in_frontmatter
            bulletized.append(line)
            continue
        if in_frontmatter or _is_already_structured(line):
            bulletized.append(line)
            continue
        # Leading whitespace (if any) is dropped because orphan paragraphs
        # should become top-level bullets under their heading, not nested.
        bulletized.append(f"- {line.strip()}")

    text = "\n".join(bulletized).rstrip() + "\n"
    # Collapse runs of 3+ blank lines to a single blank line separator.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def preserve_canonical_subtrees(current: str, reference: str) -> str:
    """Copy missing canonical subsections from the reference wiki.

    When the current wiki lacks a canonical submission subsection
    (e.g. missing `## 신규제출`) but the reference wiki has one, we
    splice the reference content in. Heading levels follow the spec:
    h1 for top sections, h2 for submission types and product categories,
    h3 for sub-details (제출 시기 / 제출 대상 및 자료 / 제출 방법).
    """

    def _parse_h1_blocks(text: str) -> dict[str, list[str]]:
        lines = text.splitlines()
        blocks: dict[str, list[str]] = {}
        current_h1: str | None = None
        for line in lines:
            h1 = re.match(r"^#\s+(.*)$", line.strip())
            if h1:
                current_h1 = h1.group(1).strip()
                blocks.setdefault(current_h1, [])
                continue
            if current_h1 is not None:
                blocks[current_h1].append(line)
        return blocks

    def _parse_h2_h3(
        lines: list[str],
    ) -> tuple[dict[str, list[str]], dict[tuple[str, str], list[str]]]:
        h2_map: dict[str, list[str]] = {}
        h3_map: dict[tuple[str, str], list[str]] = {}
        current_h2: str | None = None
        current_h3: str | None = None
        for line in lines:
            stripped = line.strip()
            h2 = re.match(r"^##\s+(.*)$", stripped)
            if h2:
                current_h2 = h2.group(1).strip()
                current_h3 = None
                h2_map.setdefault(current_h2, [])
                continue
            h3 = re.match(r"^###\s+(.*)$", stripped)
            if h3 and current_h2 is not None:
                current_h3 = h3.group(1).strip()
                h3_map.setdefault((current_h2, current_h3), [])
                continue
            if current_h3 is not None and current_h2 is not None:
                h3_map.setdefault((current_h2, current_h3), []).append(line)
            elif current_h2 is not None:
                h2_map.setdefault(current_h2, []).append(line)
        return h2_map, h3_map

    current_blocks = _parse_h1_blocks(current)
    ref_blocks = _parse_h1_blocks(reference)

    for h1 in ("첨가물정보제출", "분석결과제출"):
        if h1 not in ref_blocks:
            continue
        cur_h2, cur_h3 = _parse_h2_h3(current_blocks.get(h1, []))
        ref_h2, ref_h3 = _parse_h2_h3(ref_blocks[h1])
        for h2 in ("규제 요건", "신규제출", "변경제출", "정기제출"):
            if h2 not in cur_h2 and h2 in ref_h2:
                current_blocks.setdefault(h1, []).append(f"## {h2}")
                current_blocks[h1].extend(ref_h2[h2])
            if h2 in {"신규제출", "변경제출", "정기제출"}:
                for h3 in ("제출 시기", "제출 대상 및 자료", "제출 방법"):
                    if (h2, h3) not in cur_h3 and (h2, h3) in ref_h3:
                        if f"## {h2}" not in current_blocks.setdefault(h1, []):
                            current_blocks[h1].append(f"## {h2}")
                        current_blocks[h1].append(f"### {h3}")
                        current_blocks[h1].extend(ref_h3[(h2, h3)])

    rebuilt: list[str] = []
    lines = current.splitlines()
    idx = 0
    if lines and lines[0].strip() == "---":
        rebuilt.append(lines[0])
        idx = 1
        while idx < len(lines):
            rebuilt.append(lines[idx])
            if lines[idx].strip() == "---":
                idx += 1
                break
            idx += 1
        rebuilt.append("")

    for h1 in (
        "규제 환경 요약",
        "첨가물정보제출",
        "분석결과제출",
        "제품 규격 및 준수사항",
    ):
        if h1 in current_blocks:
            rebuilt.append(f"# {h1}")
            rebuilt.extend(current_blocks[h1])
            rebuilt.append("")

    return "\n".join(rebuilt).rstrip() + "\n"


class MdNode(BaseModel):
    id: int
    type: Literal[
        "frontmatter",
        "h1",
        "h2",
        "h3",
        "h4",
        "paragraph",
        "list",
        "numbered_list",
        "footnote_def",
        "blank",
    ]
    content: str = ""
    parent: int | None = None
    indent: int = 0
    ref: int | None = None


class MdDiff(BaseModel):
    action: Literal["update", "insert_after", "delete", "append_child"]
    id: int | None = None
    parent: int | None = None
    type: str | None = None
    content: str | None = None
    indent: int | None = None
    ref: int | None = None


def md_to_json(md: str) -> list[MdNode]:
    lines = md.split("\n")
    nodes: list[MdNode] = []
    next_id = 1
    heading_stack: dict[int, int] = {}
    idx = 0

    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is not None:
            fm_content = "\n".join(lines[1:end_idx])
            nodes.append(MdNode(id=next_id, type="frontmatter", content=fm_content))
            next_id += 1
            idx = end_idx + 1

    def current_parent() -> int | None:
        if not heading_stack:
            return None
        return heading_stack[max(heading_stack.keys())]

    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()

        if stripped == "":
            nodes.append(MdNode(id=next_id, type="blank", parent=current_parent()))
            next_id += 1
            idx += 1
            continue

        heading_match = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            content = heading_match.group(2).strip()
            parent = heading_stack.get(level - 1)
            nodes.append(
                MdNode(
                    id=next_id,
                    type=f"h{level}",
                    content=content,
                    parent=parent,
                )
            )
            heading_stack = {k: v for k, v in heading_stack.items() if k < level}
            heading_stack[level] = next_id
            next_id += 1
            idx += 1
            continue

        list_match = re.match(r"^([ \t]*)(?:(-)\s+|(\d+)\.\s+)(.*)$", line)
        if list_match:
            leading = list_match.group(1)
            is_bullet = list_match.group(2) is not None
            text = list_match.group(4).strip()
            # 탭 1개 = 1 level, 4칸 스페이스 = 1 level, 2칸 스페이스 = 1 level (fallback)
            tab_count = leading.count("\t")
            space_count = len(leading.replace("\t", ""))
            if tab_count > 0:
                indent = tab_count + (space_count // 4)
            else:
                indent = space_count // 4 or space_count // 2
            node_type = "list" if is_bullet else "numbered_list"
            nodes.append(
                MdNode(
                    id=next_id,
                    type=node_type,
                    content=text,
                    parent=current_parent(),
                    indent=indent,
                )
            )
            next_id += 1
            idx += 1
            continue

        footnote_match = re.match(r"^\[\^(\d+)\]:\s*(.*)$", stripped)
        if footnote_match:
            nodes.append(
                MdNode(
                    id=next_id,
                    type="footnote_def",
                    content=footnote_match.group(2).strip(),
                    parent=current_parent(),
                    ref=int(footnote_match.group(1)),
                )
            )
            next_id += 1
            idx += 1
            continue

        nodes.append(
            MdNode(
                id=next_id,
                type="paragraph",
                content=line,
                parent=current_parent(),
            )
        )
        next_id += 1
        idx += 1

    return nodes


def json_to_md(nodes: list[MdNode]) -> str:
    lines: list[str] = []
    footnote_lines: list[str] = []
    for node in nodes:
        if node.type == "frontmatter":
            lines.append(f"---\n{node.content}\n---")
        elif node.type == "h1":
            lines.append(f"# {node.content}")
        elif node.type == "h2":
            lines.append(f"## {node.content}")
        elif node.type == "h3":
            lines.append(f"### {node.content}")
        elif node.type == "h4":
            lines.append(f"#### {node.content}")
        elif node.type == "list":
            indent = "    " * max(node.indent, 0)
            lines.append(f"{indent}- {node.content}")
        elif node.type == "numbered_list":
            indent = "    " * max(node.indent, 0)
            # content에 번호가 이미 포함된 경우 그대로, 없으면 그대로 출력
            content = node.content
            if not re.match(r"^\d+\.\s", content):
                content = f"{node.ref if node.ref is not None else 1}. {content}"
            lines.append(f"{indent}{content}")
        elif node.type == "footnote_def":
            ref = node.ref if node.ref is not None else ""
            content = re.sub(r"^\[\^[^\]]+\]:\s*", "", node.content).strip()
            footnote_lines.append(f"[^{ref}]: {content}")
        elif node.type == "paragraph":
            lines.append(node.content)
        elif node.type == "blank":
            lines.append("")
    while lines and lines[-1] == "":
        lines.pop()
    if footnote_lines:
        if lines:
            lines.append("")
        lines.extend(footnote_lines)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def _is_blanking_update(old_content: str, new_content: str) -> bool:
    """Return True if an update would effectively blank out an existing node.

    Rationale: reviser models optimize Citation Ratio by emptying uncited
    nodes' content while leaving heading structure intact. We treat content
    reduction below 20% of the original (when original had >50 chars) or an
    outright empty string as a blanking operation that must be blocked in
    gate-pass mode.
    """
    old = (old_content or "").strip()
    new = (new_content or "").strip()
    if old and not new:
        return True
    if len(old) > 50 and len(new) < len(old) * 0.2:
        return True
    return False


def apply_json_diffs(
    nodes: list[MdNode],
    diffs: list[MdDiff],
    *,
    allow_delete: bool = True,
    allow_blank_update: bool = True,
) -> list[MdNode]:
    """Apply MdDiff operations to a node list.

    When ``allow_delete=False`` the ``delete`` action is blocked entirely
    (typically used in gate-pass mode where the reviser should only add
    citations, never remove content). When ``allow_blank_update=False``
    any ``update`` whose new content would blank out the node is also
    skipped — this prevents the "heading-only skeleton" degenerate case
    where the reviser gutted every paragraph to juice Citation Ratio.
    """
    result = [node.model_copy(deep=True) for node in nodes]
    next_id = max((node.id for node in result), default=0) + 1
    blocked_delete = 0
    blocked_blank = 0

    def find_index(node_id: int | None) -> int | None:
        if node_id is None:
            return None
        for i, node in enumerate(result):
            if node.id == node_id:
                return i
        return None

    for diff in diffs:
        if diff.action == "update":
            idx = find_index(diff.id)
            if idx is None:
                continue
            if diff.content is not None:
                if not allow_blank_update and _is_blanking_update(
                    result[idx].content, diff.content
                ):
                    blocked_blank += 1
                    continue
                result[idx].content = diff.content
            if diff.type is not None:
                result[idx].type = diff.type  # type: ignore[assignment]
            if diff.ref is not None:
                result[idx].ref = diff.ref
            if diff.indent is not None:
                result[idx].indent = diff.indent

        elif diff.action == "insert_after":
            idx = find_index(diff.id)
            if idx is None:
                continue
            result.insert(
                idx + 1,
                MdNode(
                    id=next_id,
                    type=(diff.type or "paragraph"),  # type: ignore[arg-type]
                    content=diff.content or "",
                    parent=diff.parent,
                    indent=diff.indent or 0,
                    ref=diff.ref,
                ),
            )
            next_id += 1

        elif diff.action == "delete":
            if not allow_delete:
                blocked_delete += 1
                continue
            idx = find_index(diff.id)
            if idx is None:
                continue
            del result[idx]

        elif diff.action == "append_child":
            parent_idx = find_index(diff.parent)
            if parent_idx is None:
                continue
            insert_at = parent_idx + 1
            for i in range(parent_idx + 1, len(result)):
                if result[i].parent == diff.parent:
                    insert_at = i + 1
            result.insert(
                insert_at,
                MdNode(
                    id=next_id,
                    type=(diff.type or "paragraph"),  # type: ignore[arg-type]
                    content=diff.content or "",
                    parent=diff.parent,
                    indent=diff.indent or 0,
                    ref=diff.ref,
                ),
            )
            next_id += 1

    if blocked_delete or blocked_blank:
        logger.warning(
            "apply_json_diffs blocked %d delete / %d blank-update ops",
            blocked_delete,
            blocked_blank,
        )

    return result


def compute_preservation_stats(nodes: list[MdNode]) -> dict:
    """Compute preservation metrics on a node list.

    Returns counts for heading nodes, non-heading nodes, non-empty content
    nodes, and total content bytes. Used by the preservation guard to
    detect catastrophic content loss during revise passes.
    """
    heading_count = 0
    non_heading_count = 0
    non_empty_count = 0
    total_bytes = 0
    for n in nodes:
        if n.type in ("h1", "h2", "h3", "h4"):
            heading_count += 1
        else:
            non_heading_count += 1
            content = (n.content or "").strip()
            if content:
                non_empty_count += 1
                total_bytes += len(content)
    return {
        "heading_count": heading_count,
        "non_heading_count": non_heading_count,
        "non_empty_count": non_empty_count,
        "total_bytes": total_bytes,
    }


if __name__ == "__main__":
    test_markdown = """---
title: 테스트 위키
author: 나노클로
---

# 인물 소개

## 핵심 성격
- 침착함
	- 하위 항목
1. 분석적 사고

### 상세 설명
이 인물은 위기 상황에서도 침착하게 대응한다.[^1]

[^1]: 내부 관찰 기록 요약
"""

    parsed = md_to_json(test_markdown)
    restored = json_to_md(parsed)

    assert "## 핵심 성격" in restored
    assert "[^1]:" in restored
    assert "    - 하위 항목" in restored

    print("All tests passed!")
