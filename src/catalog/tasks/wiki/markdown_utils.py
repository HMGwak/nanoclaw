"""Markdown section-based editing utilities."""

from __future__ import annotations

import re
from typing import Literal

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

        heading_match = re.match(r"^(#{2,4})\s+(.*)$", stripped)
        if heading_match and allowed_titles is not None:
            title = heading_match.group(2).strip()
            if title == "제품 규격 및 준수사항" and heading_match.group(1) == "###":
                return "### 담배 제품 (tobacco products)"
            if title not in allowed_titles:
                return f"- **{title}**"

        return line

    h2_order = [
        "규제 환경 요약",
        "첨가물정보제출",
        "분석결과제출",
        "제품 규격 및 준수사항",
    ]
    h2_aliases = {
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

    sections: dict[str, list[str]] = {h: [] for h in h2_order}
    current_h2 = h2_order[0]

    for raw in body_lines:
        line = _normalize_line(raw)
        if line is None:
            continue
        stripped = line.strip()

        heading_h2 = re.match(r"^##\s+(.*)$", stripped)
        if heading_h2:
            title = heading_h2.group(1).strip()
            if title in sections:
                current_h2 = title
                continue

        alias_hit = re.match(r"^-\s+\*\*(.+?)\*\*(?::\s*.*)?$", stripped)
        if alias_hit:
            label = alias_hit.group(1).strip()
            matched_h2 = None
            for h2, patterns in h2_aliases.items():
                if any(re.search(pattern, label) for pattern in patterns):
                    matched_h2 = h2
                    break
            if matched_h2:
                current_h2 = matched_h2
                continue

        sections[current_h2].append(line)

    def _merge_submission_section(section_lines: list[str]) -> list[str]:
        h3_order = ["규제 요건", "신규제출", "변경제출", "정기제출"]
        h4_order = ["제출 시기", "제출 대상 및 자료", "제출 방법"]
        h3_map: dict[str, list[str]] = {k: [] for k in h3_order}
        current_h3 = "규제 요건"
        current_h4: str | None = None
        nested: dict[tuple[str, str], list[str]] = {
            (h3, h4): [] for h3 in h3_order for h4 in h4_order
        }

        for line in section_lines:
            stripped = line.strip()
            h3 = re.match(r"^###\s+(.*)$", stripped)
            if h3 and h3.group(1).strip() in h3_order:
                current_h3 = h3.group(1).strip()
                current_h4 = None
                continue
            h4 = re.match(r"^####\s+(.*)$", stripped)
            if h4 and h4.group(1).strip() in h4_order:
                current_h4 = h4.group(1).strip()
                continue
            if current_h4 and current_h3 in {"신규제출", "변경제출", "정기제출"}:
                nested[(current_h3, current_h4)].append(line)
            else:
                h3_map[current_h3].append(line)

        merged: list[str] = []
        for h3 in h3_order:
            if h3_map[h3] or any(nested[(h3, h4)] for h4 in h4_order):
                merged.append(f"### {h3}")
                if h3_map[h3]:
                    merged.extend(h3_map[h3])
                if h3 in {"신규제출", "변경제출", "정기제출"}:
                    for h4 in h4_order:
                        if nested[(h3, h4)]:
                            merged.append(f"#### {h4}")
                            active_label = False
                            for item in nested[(h3, h4)]:
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
        h3_order = [
            "담배 원료 (tobacco)",
            "담배 외 원료 및 재료 (other than tobacco)",
            "담배 제품 (tobacco products)",
        ]
        h3_map: dict[str, list[str]] = {k: [] for k in h3_order}
        current_h3 = "담배 제품 (tobacco products)"

        for line in section_lines:
            stripped = line.strip()
            h3 = re.match(r"^###\s+(.*)$", stripped)
            if h3 and h3.group(1).strip() in h3_order:
                current_h3 = h3.group(1).strip()
                continue
            h3_map[current_h3].append(line)

        merged: list[str] = []
        for h3 in h3_order:
            merged.append(f"### {h3}")
            merged.extend(h3_map[h3])
        return merged

    rebuilt: list[str] = []
    if frontmatter:
        rebuilt.extend(frontmatter)
        rebuilt.append("")

    for h2 in h2_order:
        rebuilt.append(f"## {h2}")
        section_lines = sections[h2]
        if h2 in {"첨가물정보제출", "분석결과제출"}:
            rebuilt.extend(_merge_submission_section(section_lines))
        elif h2 == "제품 규격 및 준수사항":
            rebuilt.extend(_merge_product_section(section_lines))
        else:
            rebuilt.extend(section_lines)
        if rebuilt and rebuilt[-1] != "":
            rebuilt.append("")

    def _repair_product_label_nesting(lines: list[str]) -> list[str]:
        fixed: list[str] = []
        in_submission_materials = False
        active_label = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("#### "):
                in_submission_materials = stripped == "#### 제출 대상 및 자료"
                active_label = False
                fixed.append(line)
                continue
            if stripped.startswith("### ") or stripped.startswith("## "):
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
    return "\n".join(rebuilt).rstrip() + "\n"


def preserve_canonical_subtrees(current: str, reference: str) -> str:
    def _parse_h2_blocks(text: str) -> dict[str, list[str]]:
        lines = text.splitlines()
        blocks: dict[str, list[str]] = {}
        current_h2: str | None = None
        for line in lines:
            h2 = re.match(r"^##\s+(.*)$", line.strip())
            if h2:
                current_h2 = h2.group(1).strip()
                blocks.setdefault(current_h2, [])
                continue
            if current_h2 is not None:
                blocks[current_h2].append(line)
        return blocks

    def _parse_h3_h4(
        lines: list[str],
    ) -> tuple[dict[str, list[str]], dict[tuple[str, str], list[str]]]:
        h3_map: dict[str, list[str]] = {}
        h4_map: dict[tuple[str, str], list[str]] = {}
        current_h3: str | None = None
        current_h4: str | None = None
        for line in lines:
            stripped = line.strip()
            h3 = re.match(r"^###\s+(.*)$", stripped)
            if h3:
                current_h3 = h3.group(1).strip()
                current_h4 = None
                h3_map.setdefault(current_h3, [])
                continue
            h4 = re.match(r"^####\s+(.*)$", stripped)
            if h4 and current_h3 is not None:
                current_h4 = h4.group(1).strip()
                h4_map.setdefault((current_h3, current_h4), [])
                continue
            if current_h4 is not None and current_h3 is not None:
                h4_map.setdefault((current_h3, current_h4), []).append(line)
            elif current_h3 is not None:
                h3_map.setdefault(current_h3, []).append(line)
        return h3_map, h4_map

    current_blocks = _parse_h2_blocks(current)
    ref_blocks = _parse_h2_blocks(reference)

    for h2 in ("첨가물정보제출", "분석결과제출"):
        if h2 not in ref_blocks:
            continue
        cur_h3, cur_h4 = _parse_h3_h4(current_blocks.get(h2, []))
        ref_h3, ref_h4 = _parse_h3_h4(ref_blocks[h2])
        for h3 in ("규제 요건", "신규제출", "변경제출", "정기제출"):
            if h3 not in cur_h3 and h3 in ref_h3:
                current_blocks.setdefault(h2, []).append(f"### {h3}")
                current_blocks[h2].extend(ref_h3[h3])
            if h3 in {"신규제출", "변경제출", "정기제출"}:
                for h4 in ("제출 시기", "제출 대상 및 자료", "제출 방법"):
                    if (h3, h4) not in cur_h4 and (h3, h4) in ref_h4:
                        if f"### {h3}" not in current_blocks.setdefault(h2, []):
                            current_blocks[h2].append(f"### {h3}")
                        current_blocks[h2].append(f"#### {h4}")
                        current_blocks[h2].extend(ref_h4[(h3, h4)])

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

    for h2 in (
        "규제 환경 요약",
        "첨가물정보제출",
        "분석결과제출",
        "제품 규격 및 준수사항",
    ):
        if h2 in current_blocks:
            rebuilt.append(f"## {h2}")
            rebuilt.extend(current_blocks[h2])
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
    indent: int = 0
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
    return "\n".join(lines)


def apply_json_diffs(nodes: list[MdNode], diffs: list[MdDiff]) -> list[MdNode]:
    result = [node.model_copy(deep=True) for node in nodes]
    next_id = max((node.id for node in result), default=0) + 1

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
                result[idx].content = diff.content
            if diff.type is not None:
                result[idx].type = diff.type  # type: ignore[assignment]
            if diff.ref is not None:
                result[idx].ref = diff.ref
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
                    indent=diff.indent,
                    ref=diff.ref,
                ),
            )
            next_id += 1

        elif diff.action == "delete":
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
                    indent=diff.indent,
                    ref=diff.ref,
                ),
            )
            next_id += 1

    return result


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
