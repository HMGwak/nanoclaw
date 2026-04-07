"""ChunkedSynthesizer - Map-Reduce wiki synthesis engine.

Map phase : split docs into batches of ~batch_size, extract structured patterns
            per batch via LLM (returns JSON).
Reduce phase: merge all batch extractions into a single wiki note (Markdown).

Supports:
- create  : build a new wiki note from scratch
- update  : merge new extractions into an existing wiki note
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from pydantic import BaseModel

try:
    from .json_utils import try_parse_validated, parse_validated_list
    from .markdown_utils import (
        MarkdownSectionEditor,
        SectionEdit,
        strip_code_blocks,
        filter_attachment_footnotes,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
    )
except ImportError:
    from json_utils import try_parse_validated, parse_validated_list  # type: ignore[no-redef]
    from markdown_utils import (  # type: ignore[no-redef]
        MarkdownSectionEditor,
        SectionEdit,
        strip_code_blocks,
        filter_attachment_footnotes,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
    )


class MapExtraction(BaseModel):
    반복_입력자료: list[str] = []
    반복_산출물: list[str] = []
    절차_단계: list[str] = []
    사례별_특이점: list[dict] = []
    주요_키워드: list[str] = []

logger = logging.getLogger(__name__)


# ── Prompts ───────────────────────────────────────────────────────

MAP_SYSTEM_PROMPT = """\
You are an expert at extracting recurring patterns from raw work documents.
Analyze the given batch of raw documents and respond ONLY with a JSON object in the following structure.

{
  "반복_입력자료": ["item1", "item2", ...],
  "반복_산출물": ["item1", "item2", ...],
  "절차_단계": ["1. step", "2. step", ...],
  "사례별_특이점": [
    {"사례": "filename or case identifier", "특이사항": "description"}
  ],
  "주요_키워드": ["keyword1", "keyword2", ...]
}

Rules:
- Output ONLY valid JSON. No other text.
- Do NOT add any content not present in the raw documents (no hallucination).
- Prioritize patterns that appear repeatedly across documents.
- Write all extracted values in Korean, matching the original document language.
"""

_REDUCE_SYSTEM_BASE = """\
You are an expert wiki author. Synthesize the extracted pattern JSONs from multiple batches into a structured wiki note.

{structure_block}

Rules:
- Use Obsidian-standard footnotes:
  - In-text: [^1][^2] (numeric, short)
  - At bottom in ## 각주 section: [^1]: [[(filename)]]
  - Omit .md extension from footnote definitions
- Every factual sentence MUST have at least one footnote citation.
- Do NOT add any content not present in the raw documents (no hallucination).
- Write concretely so a new team member can perform the same task using only this wiki.
- Write ALL output in Korean.
- Use bullet points (- ), numbered lists (1. 2. 3.), and indentation actively to improve readability.
- Prefer structured lists over long prose paragraphs. Break down complex information into scannable bullet points.
- Use indented sub-items (tab + -) for hierarchical details.
"""

_DEFAULT_STRUCTURE = [
    "## 핵심 성격",
    "## 반복 패턴",
    "### 반복 입력자료",
    "### 반복 산출물",
    "## 절차",
    "## 대표 사례 (최소 3개, 각 사례에 각주 참조)",
    "## 열린 이슈 (불확실하거나 추가 확인이 필요한 항목)",
]


def _build_reduce_system_prompt(doc_structure: list[str] | None = None) -> str:
    headings = doc_structure or _DEFAULT_STRUCTURE
    lines = [
        "IMPORTANT: You MUST use EXACTLY the following heading structure. Do NOT add, rename, or reorder sections.",
        "",
        "Required wiki note structure:",
        "1. YAML frontmatter (tags, created, domain)",
    ]
    for i, h in enumerate(headings, 2):
        lines.append(f"{i}. {h}")
    lines.append(f"{len(headings) + 2}. 각주 섹션 (raw 문서 파일명 기반)")

    # Template pattern: {국가} → repeat per country
    has_template = any("{국가}" in h for h in headings)
    if has_template:
        lines.append("")
        lines.append("Template rule for {국가}:")
        lines.append("- Headings marked with {국가} MUST be repeated for EACH country found in the raw documents.")
        lines.append("- Replace {국가} with the actual country name (e.g. ### 대만, ### 러시아, ### 나이지리아).")
        lines.append("- Under each country heading, include: 절차, 필수 서류, 주요 사례 as bullet points or sub-content.")
        lines.append("- PMI and PMIzhora are NOT countries — they are partner organizations. Treat them as SEPARATE headings (e.g. ### PMI, ### PMIzhora) distinct from country headings.")
        lines.append("- If a document involves both a country AND PMI/PMIzhora, place country-specific content under the country heading and PMI/PMIzhora coordination content under the respective partner heading.")

    structure_block = "\n".join(lines)
    return _REDUCE_SYSTEM_BASE.format(structure_block=structure_block)

UPDATE_REDUCE_SYSTEM_PROMPT = """\
You are an expert wiki update author.
The existing wiki is provided as a JSON node array. Each node has: id, type, content, parent, indent.

Respond ONLY with a JSON array of diffs:
[
  {"action": "update", "id": 3, "content": "new content"},
  {"action": "insert_after", "id": 7, "type": "list", "parent": 5, "indent": 1, "content": "added item"},
  {"action": "delete", "id": 10},
  {"action": "append_child", "parent": 4, "type": "list", "indent": 0, "content": "new list item"}
]

Rules:
- Target nodes by id (NOT by line number or text matching).
- When adding nodes: type and parent are required.
- Footnotes: use type="footnote_def", ref=number.
- Preserve existing content; only add/modify with new information.
- Continue footnote numbering from the highest existing number. Obsidian format: in-text [^1], bottom [^1]: [[(filename)]].
- Remove duplicates and update with the latest information.
- Write ALL content values in Korean.
"""


# ── ChunkedSynthesizer ────────────────────────────────────────────

class ChunkedSynthesizer:
    """Map-Reduce wiki synthesis from a large set of raw documents.

    Args:
        agent: Any object with a ``generate(system_prompt, user_prompt) -> str``
               method (e.g. WikiAgent, ChatGPTClient-based agent).
        batch_size: Number of documents processed per map step.
    """

    def __init__(self, agent, batch_size: int = 10, doc_structure: list[str] | None = None) -> None:
        self.agent = agent
        self.doc_structure = doc_structure

        # Adaptive batch size based on model
        model_name = getattr(agent, "model", "").lower()
        if "e4b" in model_name:
            self.batch_size = 5
        elif "26b" in model_name:
            self.batch_size = 15
        elif "gpt-5.4" in model_name or "gpt-4" in model_name:
            self.batch_size = 30
        else:
            self.batch_size = batch_size

    # ── Public API ────────────────────────────────────────────────

    def synthesize(
        self,
        docs: list[Path],
        existing_wiki: str | None = None,
        domain: str = "",
        reference_files: list[Path] | None = None,
    ) -> tuple[str, list[str]]:
        """Synthesize docs into a wiki note via map-reduce.

        Args:
            docs: Raw document paths to synthesize.
            existing_wiki: Existing wiki note content for update mode.
                           If None, a new wiki note is created.
            domain: Domain label included in reduce prompt for context.
            reference_files: Additional reference paths (appended to docs
                             for footnote listing; not read twice if already
                             in docs).

        Returns:
            Tuple of (wiki markdown string, list of successfully processed doc paths).
        """
        if not docs:
            logger.warning("synthesize() called with empty docs list")
            return (existing_wiki or "", [])

        # Map phase - processes all docs in batches
        extractions = self._map(docs)
        if not extractions:
            return (existing_wiki or "", [])

        # Track successfully processed docs
        self._succeeded_docs: list[str] = []

        # Reduce phase - iterative update to avoid model degradation
        if existing_wiki:
            wiki = self._update_reduce(extractions, existing_wiki, docs, domain)
        else:
            # Iterative create: Use first batch to create initial wiki, then update
            logger.info("Creating initial wiki from first batch")
            first_batch_docs = docs[:self.batch_size]
            wiki = self._create_reduce([extractions[0]], first_batch_docs, domain)
            # First batch create is always counted as success if map succeeded
            if extractions[0].get("_map_ok", True):
                self._succeeded_docs.extend(extractions[0].get("_source_paths", []))

            if len(extractions) > 1:
                logger.info("Iteratively updating wiki with remaining %d batches", len(extractions) - 1)
                remaining_docs = docs[self.batch_size:]
                wiki = self._update_reduce(extractions[1:], wiki, remaining_docs, domain)

        # Post-processing
        wiki = strip_code_blocks(wiki)
        wiki = filter_attachment_footnotes(wiki)

        succeeded = list(self._succeeded_docs)
        logger.info("Successfully processed %d/%d docs", len(succeeded), len(docs))
        return (wiki, succeeded)

    # ── Map phase ─────────────────────────────────────────────────

    def _map(self, docs: list[Path]) -> list[dict]:
        """Extract patterns from each batch; return list of parsed dicts."""
        batches = self._batch(docs, self.batch_size)
        extractions: list[dict] = []

        for i, batch in enumerate(batches):
            logger.info("Map batch %d/%d (%d docs)", i + 1, len(batches), len(batch))
            raw_text = self._build_batch_text(batch)
            response = self.agent.generate(
                system_prompt=MAP_SYSTEM_PROMPT,
                user_prompt=f"=== 배치 {i + 1} / {len(batches)} ===\n\n{raw_text}",
            )
            parsed = self._parse_map_response(response, batch)
            extractions.append(parsed)

        return extractions

    def _build_batch_text(self, batch: list[Path]) -> str:
        parts: list[str] = []
        for path in batch:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as exc:
                logger.warning("Cannot read %s: %s", path, exc)
                content = "(읽기 실패)"
            parts.append(f"--- {path.name} ---\n{content}")
        return "\n\n".join(parts)

    def _parse_map_response(self, response: str, batch: list[Path]) -> dict:
        """Parse LLM JSON response; fall back to empty structure on error."""
        sources = [p.name for p in batch]
        source_paths = [str(p) for p in batch]
        extraction = try_parse_validated(response, MapExtraction)
        if extraction:
            data = extraction.model_dump()
            data["_sources"] = sources
            data["_source_paths"] = source_paths
            data["_map_ok"] = True
            return data
        else:
            logger.warning("Map response parse failed, using empty extraction")
            return {
                "반복_입력자료": [],
                "반복_산출물": [],
                "절차_단계": [],
                "사례별_특이점": [],
                "주요_키워드": [],
                "_sources": sources,
                "_source_paths": source_paths,
                "_map_ok": False,
            }

    # ── Reduce phase ──────────────────────────────────────────────

    def _create_reduce(
        self, extractions: list[dict], docs: list[Path], domain: str
    ) -> str:
        """Reduce extractions into a new wiki note."""
        user_prompt = self._build_reduce_user_prompt(extractions, docs, domain)
        system_prompt = _build_reduce_system_prompt(self.doc_structure)
        return self.agent.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )

    def _update_reduce(
        self,
        extractions: list[dict],
        existing_wiki: str,
        docs: list[Path],
        domain: str,
    ) -> str:
        """Iteratively merge extractions into an existing wiki note using JSON node diffs."""
        current_wiki = existing_wiki

        for i, ext in enumerate(extractions):
            logger.info("Updating wiki with extraction %d/%d", i + 1, len(extractions))

            nodes = md_to_json(current_wiki)
            ext_text = json.dumps(ext, ensure_ascii=False, indent=2)
            sources = ext.get("_sources", [])
            source_list = "\n".join(f"- {s}" for s in sources)
            domain_line = f"도메인: {domain}\n\n" if domain else ""

            nodes_json = json.dumps([n.model_dump() for n in nodes], ensure_ascii=False, indent=2)
            user_prompt = (
                f"{domain_line}"
                f"기존 wiki (JSON 노드):\n{nodes_json}\n\n"
                f"신규 추출 패턴:\n{ext_text}\n\n"
                f"=== 이번 배치 raw 문서 목록 ===\n{source_list}"
            )

            diff_response = self.agent.generate(
                system_prompt=UPDATE_REDUCE_SYSTEM_PROMPT,
                user_prompt=user_prompt,
            )

            # Apply JSON node diffs to current wiki
            prev_wiki = current_wiki
            current_wiki = self._apply_section_diffs(current_wiki, diff_response)

            # Track success: wiki changed means diffs were applied
            if current_wiki != prev_wiki and ext.get("_map_ok", True):
                self._succeeded_docs.extend(ext.get("_source_paths", []))

        return current_wiki

    def _apply_section_diffs(self, original: str, response: str) -> str:
        """Apply JSON node diffs from LLM response."""
        nodes = md_to_json(original)
        try:
            diffs = parse_validated_list(response, MdDiff)
        except ValueError as exc:
            logger.warning("MdDiff parse failed, keeping original. error=%s response_preview=%.500s", exc, response)
            return original
        if not diffs:
            logger.warning("MdDiff response yielded 0 valid diffs. response_preview=%.500s", response)
            return original
        logger.info("Applying %d MdDiff operations", len(diffs))
        updated = apply_json_diffs(nodes, diffs)
        return json_to_md(updated)

    def _build_reduce_user_prompt(
        self, extractions: list[dict], docs: list[Path], domain: str
    ) -> str:
        extractions_text = _format_extractions(extractions)
        source_list = "\n".join(f"- {p.name}" for p in docs)
        domain_line = f"도메인: {domain}\n\n" if domain else ""

        return (
            f"{domain_line}"
            f"=== 배치별 추출 패턴 ({len(extractions)}개 배치) ===\n{extractions_text}\n\n"
            f"=== raw 문서 목록 (각주 참조용) ===\n{source_list}"
        )

    # ── Helpers ───────────────────────────────────────────────────

    @staticmethod
    def _batch(items: list[Path], size: int) -> list[list[Path]]:
        return [items[i : i + size] for i in range(0, len(items), size)]


# ── Module-level helpers ──────────────────────────────────────────

def _format_extractions(extractions: list[dict]) -> str:
    """Pretty-print list of extraction dicts for the reduce prompt."""
    parts: list[str] = []
    for i, ext in enumerate(extractions, 1):
        sources = ext.get("_sources", [])
        sources_str = ", ".join(sources) if sources else "unknown"
        try:
            text = json.dumps(ext, ensure_ascii=False, indent=2)
        except Exception:
            text = str(ext)
        parts.append(f"--- 배치 {i} (출처: {sources_str}) ---\n{text}")
    return "\n\n".join(parts)


