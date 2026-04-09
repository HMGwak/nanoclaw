"""ChunkedSynthesizer - Map-Reduce wiki synthesis engine.

Map phase : Codex SDK 에이전트가 전체 문서를 병렬 탐색하여 구조화된 claim JSON 반환.
            (2026-04-08 대체: 기존 배치별 agent.generate() → Codex SDK 1회 호출)
Reduce phase: merge all extractions into a single wiki note (Markdown).

=== Legacy MAP (2026-04-08 이전) ===
- 문서를 batch_size 단위로 분할 → 배치마다 agent.generate() 호출
- 배치 내 패턴만 추출 (배치 간 교차 패턴 미포착)
- 원문 quote 미보존 (패턴 요약만)
- 레거시 코드: legacy/map_legacy.py 참조

=== Codex MAP (현재) ===
- Codex SDK에 전체 문서 경로 전달 → 서브에이전트가 병렬 탐색
- 문서 간 교차 패턴 포착, 원문 quote 100% 보존
- 1회 호출로 전체 처리 (claim JSON + patterns)
- claim → extraction 변환 후 기존 REDUCE와 호환

Supports:
- create  : build a new wiki note from scratch
- update  : merge new extractions into an existing wiki note
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import time
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


# MapExtraction은 legacy/map_legacy.py로 이동 (2026-04-08)

logger = logging.getLogger(__name__)

# ── Codex MAP 설정 ───────────────────────────────────────────────
# 2026-04-08: 배치별 agent.generate() 방식에서 Codex SDK 1회 호출로 대체.
# 레거시 MAP 코드: legacy/map_legacy.py 참조.

try:
    from catalog.sdk_profiles.codex_oauth import run_codex_prompt
except ImportError:
    try:
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).parent.parent.parent))
        from catalog.sdk_profiles.codex_oauth import run_codex_prompt  # type: ignore[no-redef]
    except ImportError:
        run_codex_prompt = None  # type: ignore[assignment]

CODEX_MAP_CLAIM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "claim": {"type": "string"},
                    "quote": {"type": "string"},
                    "doc_id": {"type": "string"},
                    "section_target": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["claim", "quote", "doc_id", "section_target", "confidence"],
            },
        },
        "patterns": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "반복_입력자료": {"type": "array", "items": {"type": "string"}},
                "반복_산출물": {"type": "array", "items": {"type": "string"}},
                "절차_단계": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["반복_입력자료", "반복_산출물", "절차_단계"],
        },
    },
    "required": ["claims", "patterns"],
}

CODEX_MAP_PROMPT_TEMPLATE = """\
당신은 문서 분석 오케스트레이터입니다.
아래 {doc_count}개 문서에서 반복 패턴과 개별 claim을 추출하세요.

문서 경로 목록:
{doc_listing}

작업 절차:
1. 목록 파일을 cat으로 읽어 경로 목록을 파악하세요
2. 각 문서를 순서대로 cat으로 읽으세요
3. 문서를 읽은 직후, 목록 파일에서 해당 항목의 `- [ ]`를 `- [x]`로 수정하세요 (sed 사용)
4. 각 문서에서 핵심 사실/절차/이슈를 claim으로 추출하세요
5. 중복되는 claim은 병합하고 doc_id 목록을 통합하세요
6. 반복 패턴 (입력자료, 산출물, 절차 단계)을 정리하세요
7. 모든 문서 처리 후 최종 JSON을 반환하세요

문서별 처리 로그:
- 각 문서를 읽은 후 아래 디렉토리에 문서명과 동일한 JSON 파일을 생성하세요:
  {doc_log_dir}
- 형식: {{"doc":"파일명.md","claims":추출수,"summary":"핵심 1줄 요약"}}
- claim이 0이면: {{"doc":"파일명.md","claims":0,"reason":"스킵 사유"}}
- 예: echo '{{"doc":"TANN.md","claims":2,"summary":"VOC 시험 흐름"}}' > {doc_log_dir}/TANN.md.json

각 claim에 반드시 포함할 필드:
- claim: 핵심 사실 (한국어)
- quote: 원문 근거 1-2문장
- doc_id: 파일명 (여러 문서에 걸친 경우 세미콜론으로 연결)
- section_target: 이 claim이 들어갈 wiki 섹션 (예: "## 절차", "## 열린 이슈")
- confidence: high/medium/low

패턴 정리 규칙:
- patterns 배열의 각 문자열은 원자 항목 1개만 작성하세요.
- 쉼표(,)로 여러 항목을 한 문자열에 합치지 마세요.
- 가능한 경우 성격별 라벨을 붙이세요 (예: "문서: BOM", "시스템: SAP", "시험: 연기성분").

파일 접근 불가 시:
- cat으로 문서를 읽을 때 permission denied, bwrap 오류, 빈 내용이 반환되면 즉시 중단하세요.
- 읽지 못한 문서로 claim을 만들지 마세요.
- 접근 불가 시 error: "FILE_ACCESS_DENIED"를 포함한 JSON을 반환하세요.

원문에 없는 내용은 절대 추가하지 마세요."""


# ── Prompts (REDUCE) ─────────────────────────────────────────────

_REDUCE_SYSTEM_BASE = """\
You are an expert wiki author. Synthesize the extracted pattern JSONs from multiple batches into a structured wiki note.

{structure_block}

Rules:
- Use Obsidian-standard footnotes:
  - In-text: [^1][^2] (numeric, short)
  - At bottom in ## 각주 section: [^1]: [[(filename)]]
  - Omit .md extension from footnote definitions
- Every factual paragraph or bullet block MUST have at least one footnote citation. Not every single sentence needs its own citation — group citations at the paragraph/block level.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis (finding patterns across multiple docs) is allowed and encouraged — this is the purpose of a wiki.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된" or "확인된 바에 따르면". Write direct factual sentences. Evidence is conveyed by footnote citations, not by repetitive source-assertion language.
- Write concretely so a new team member can perform the same task using only this wiki.
- Write ALL output in Korean.
- Organize by meaning, not by exhaustive enumeration.
- Do NOT use comma-chain sentences with 5+ items. If many items exist, group them into 2-4 labeled categories with one item per bullet.
- Use bullets for procedures/checklists/decision branches, not for dumping all extracted items.
- Do NOT use markdown tables (| |). Use grouped bullet lists instead.
- Use indented sub-items with 4-space indent (NOT tab). Obsidian requires 4-space indentation for nested lists. Example:
  - Level 0: `- item`
  - Level 1: `    - sub-item` (4 spaces)
  - Level 2: `        - sub-sub-item` (8 spaces)
- For country/region sections, keep depth balanced. Include comparable sub-items (절차/필수 서류/주요 사례). If evidence is sparse, add one bullet stating the limitation with citation.
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


def _build_structure_block(doc_structure: list[str] | None = None) -> str:
    """Build the wiki structure instruction block (shared by reduce and incremental prompts)."""
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

    return "\n".join(lines)


def _build_reduce_system_prompt(doc_structure: list[str] | None = None) -> str:
    structure_block = _build_structure_block(doc_structure)
    return _REDUCE_SYSTEM_BASE.format(structure_block=structure_block)

INCREMENTAL_CREATE_SYSTEM_PROMPT = """\
You are an expert wiki author. Read the raw work documents below and create a structured wiki note.

{structure_block}

Rules:
- Use Obsidian-standard footnotes:
  - In-text: [^1][^2] (numeric, short)
  - At bottom in ## 각주 section: [^1]: [[(filename)]]
  - Omit .md extension from footnote definitions
- Every factual paragraph or bullet block MUST have at least one footnote citation. Group citations at the paragraph/block level.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences with footnote citations.
- Write concretely so a new team member can perform the same task using only this wiki.
- Write ALL output in Korean.
- Organize by meaning, not by exhaustive enumeration. Do NOT use comma-chain sentences with 5+ items.
- Do NOT use markdown tables (| |). Use grouped bullet lists instead.
- Use bullets for procedures/checklists, not for dumping all extracted items.
"""

INCREMENTAL_UPDATE_SYSTEM_PROMPT = """\
You are an expert wiki update author.
Read the raw work documents below and update the existing wiki with new information.

The existing wiki is provided as a JSON node array. Each node has: id, type, content, parent, indent.

Respond ONLY with a JSON array of diffs:
[
  {"action": "update", "id": 3, "content": "new content with [^N] citation"},
  {"action": "insert_after", "id": 7, "type": "list", "parent": 5, "indent": 1, "content": "added item [^N]"},
  {"action": "delete", "id": 10},
  {"action": "append_child", "parent": 4, "type": "list", "indent": 0, "content": "new list item [^N]"}
]

Rules:
- Target nodes by id (NOT by line number or text matching).
- When adding nodes: type and parent are required.
- Footnotes: use type="footnote_def", ref=number. Obsidian format: in-text [^1], bottom [^1]: [[(filename)]].
- Continue footnote numbering from the highest existing number.
- Preserve existing content; only add/modify with new information from the raw documents.
- Every new factual paragraph or bullet block MUST cite the source document via footnote.
- Remove duplicates and update with the latest information.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences.
- Do NOT use comma-chain sentences with 5+ items. Group items into labeled categories.
- Do NOT use markdown tables (| |).
- Write ALL content values in Korean.
"""

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
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences.
- Do NOT use comma-chain sentences with 5+ items. Group items into labeled categories.
- Do NOT use markdown tables (| |).
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

    def __init__(self, agent, batch_size: int = 10, doc_structure: list[str] | None = None, vault_root: Path | None = None) -> None:
        self.agent = agent
        self.doc_structure = doc_structure
        self._vault_root = vault_root

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
        cache_dir: Path | None = None,
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

        # Map phase — Codex SDK가 전체 문서를 1회 호출로 분석
        extractions = self._map(docs, cache_dir=cache_dir)
        if not extractions:
            return (existing_wiki or "", [])

        # Track successfully processed docs
        self._succeeded_docs: list[str] = []

        # Reduce phase
        # Codex MAP은 항상 1개 extraction을 반환 (전체 문서 통합 분석).
        if existing_wiki:
            wiki = self._update_reduce(extractions, existing_wiki, docs, domain)
        else:
            wiki = self._create_reduce(extractions, docs, domain)
            if extractions[0].get("_map_ok", True):
                self._succeeded_docs.extend(extractions[0].get("_source_paths", []))

        # Post-processing
        wiki = strip_code_blocks(wiki)
        wiki = filter_attachment_footnotes(wiki)

        succeeded = list(self._succeeded_docs)
        logger.info("Successfully processed %d/%d docs", len(succeeded), len(docs))
        return (wiki, succeeded)

    # ── Map phase (Codex SDK) ────────────────────────────────────
    # 2026-04-08 대체: 배치별 agent.generate() → Codex SDK 1회 호출.
    # 기존 코드: legacy/map_legacy.py 참조.
    #
    # [작동 원리]
    # 1. 전체 문서 경로를 Codex SDK에 전달 (run_codex_prompt)
    # 2. Codex 오케스트레이터가 doc_explorer 서브에이전트를 병렬 소환
    # 3. 각 서브에이전트가 문서를 읽고 claim(사실/절차/이슈) 추출
    # 4. 오케스트레이터가 claim 누적/중복 병합/패턴 정제 → JSON 반환
    # 5. _claims_to_extractions()로 기존 REDUCE 호환 형태로 변환

    def _map(self, docs: list[Path], cache_dir: Path | None = None) -> list[dict]:
        """Codex SDK MAP: 1회 호출로 전체 문서를 분석하여 claim 추출.

        Codex 오케스트레이터가 doc_explorer 서브에이전트를 병렬 소환하여
        각 문서를 탐색하고, 구조화된 claim JSON을 반환한다.
        cwd를 vault_root로 설정하여 sandbox에서 파일 접근 가능.
        """
        if run_codex_prompt is None:
            raise RuntimeError(
                "Codex SDK not available. Install @openai/codex-sdk and "
                "ensure codex_oauth.py is importable."
            )

        # 캐시 확인
        cache_file: Path | None = None
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file = cache_dir / "codex_map_claims.json"
            if cache_file.exists():
                try:
                    cached = json.loads(cache_file.read_text(encoding="utf-8"))
                    logger.info("Codex MAP loaded from cache (%d claims)", len(cached.get("claims", [])))
                    return self._claims_to_extractions(cached, docs)
                except Exception:
                    pass

        # 문서 경로 목록을 파일로 저장 (프롬프트 크기를 문서 수와 무관하게 유지)
        # sandbox cwd=vault_root이므로, doc_list 파일도 vault_root 아래에 있어야 접근 가능
        if self._vault_root:
            doc_list_dir = self._vault_root / ".codex_tmp"
            doc_list_dir.mkdir(parents=True, exist_ok=True)
            doc_list_file = doc_list_dir / "_codex_doc_list.md"
        elif cache_dir:
            doc_list_file = cache_dir / "_codex_doc_list.md"
        else:
            doc_list_file = Path("/tmp/_codex_doc_list.md")
        doc_list_file.parent.mkdir(parents=True, exist_ok=True)
        relative_paths: list[str] = []
        for p in docs:
            try:
                relative_paths.append(str(p.relative_to(self._vault_root)) if self._vault_root else str(p))
            except ValueError:
                relative_paths.append(str(p))
        doc_list_file.write_text("\n".join(f"- [ ] {rp}" for rp in relative_paths), encoding="utf-8")

        # 문서별 처리 로그 디렉토리
        doc_log_dir = doc_list_file.parent / "_codex_map_log"
        doc_log_dir.mkdir(parents=True, exist_ok=True)

        prompt = CODEX_MAP_PROMPT_TEMPLATE.format(
            doc_count=len(docs),
            doc_listing=f"문서 경로 목록은 아래 파일에 한 줄에 하나씩 저장되어 있습니다. cat으로 읽으세요:\n{doc_list_file.resolve()}",
            doc_log_dir=str(doc_log_dir.resolve()),
        )

        logger.info("Codex MAP: %d docs 전송 (cwd=%s, doc_list=%s)...",
                     len(docs),
                     str(self._vault_root) if self._vault_root else "project",
                     doc_list_file)
        start = time.time()

        result = run_codex_prompt(
            prompt=prompt,
            cwd=str(self._vault_root) if self._vault_root else str(Path.cwd()),
            reasoning_effort="high",
            output_schema=CODEX_MAP_CLAIM_SCHEMA,
        )

        # 임시 파일 삭제
        doc_list_file.unlink(missing_ok=True)
        if self._vault_root:
            try:
                (self._vault_root / ".codex_tmp").rmdir()
            except OSError:
                pass  # not empty or already removed

        elapsed = time.time() - start
        logger.info("Codex MAP 완료: %.1fs (ok=%s)", elapsed, result["ok"])

        if not result["ok"]:
            logger.error("Codex MAP failed: %s", result["message"])
            return []

        # 응답 파싱 (디버그: raw output 로깅)
        raw_output = result.get("output", "")
        logger.info("Codex MAP raw output (first 1000 chars): %.1000s", raw_output)
        claims_data = self._parse_codex_response(raw_output)
        if claims_data is None:
            logger.error("Codex MAP response is not valid JSON")
            return []

        # FILE_ACCESS_DENIED 감지
        if claims_data.get("error") == "FILE_ACCESS_DENIED":
            failed = claims_data.get("failed_files", [])
            logger.error("Codex MAP: FILE_ACCESS_DENIED — %d files. Check sandbox cwd. Failed: %s",
                         len(failed), failed[:5])
            return []

        claims = claims_data.get("claims", [])
        logger.info("Codex MAP: %d claims, patterns: %s",
                     len(claims),
                     {k: len(v) for k, v in claims_data.get("patterns", {}).items()})

        # 문서별 처리 로그 수집 (per-doc JSON files → merged log)
        if doc_log_dir.exists() and cache_dir:
            doc_log_entries = []
            for log_file in doc_log_dir.glob("*.json"):
                try:
                    entry = json.loads(log_file.read_text(encoding="utf-8"))
                    doc_log_entries.append(entry)
                except (json.JSONDecodeError, OSError):
                    doc_log_entries.append({"doc": log_file.stem, "claims": -1, "reason": "log parse error"})
            if doc_log_entries:
                doc_log_dest = cache_dir / "codex_map_doc_log.json"
                doc_log_dest.write_text(
                    json.dumps(doc_log_entries, ensure_ascii=False, indent=2), encoding="utf-8")
                skipped = sum(1 for d in doc_log_entries if d.get("claims", 0) == 0)
                logger.info("Codex MAP doc log: %d entries (%d with claims, %d skipped) → %s",
                            len(doc_log_entries), len(doc_log_entries) - skipped, skipped, doc_log_dest)
            else:
                logger.warning("Codex MAP doc log directory is empty")
            # 로그 디렉토리 정리
            shutil.rmtree(doc_log_dir, ignore_errors=True)

        if not claims:
            logger.error("Codex MAP produced 0 claims from %d docs", len(docs))
            return []

        # 캐시 저장
        if cache_file:
            try:
                cache_file.write_text(
                    json.dumps(claims_data, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                logger.warning("Failed to write Codex MAP cache")

        return self._claims_to_extractions(claims_data, docs)

    @staticmethod
    def _parse_codex_response(output: str) -> dict | None:
        """Parse Codex MAP JSON response, with fallback extraction."""
        if not output:
            return None
        try:
            return json.loads(output)
        except (json.JSONDecodeError, TypeError):
            match = re.search(r'\{[\s\S]*\}', output)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    return None
            return None

    @staticmethod
    def _claims_to_extractions(claims_data: dict, docs: list[Path]) -> list[dict]:
        """Codex claim JSON → 기존 REDUCE 호환 extraction 형태로 변환."""
        patterns = claims_data.get("patterns", {})
        claims = claims_data.get("claims", [])

        cases = []
        keywords: set[str] = set()
        for c in claims:
            cases.append({
                "사례": c.get("doc_id", ""),
                "특이사항": f"{c['claim']} — \"{c.get('quote', '')}\"",
                "section_target": c.get("section_target", ""),
                "confidence": c.get("confidence", "medium"),
            })
            for word in c.get("claim", "").split():
                if len(word) > 2:
                    keywords.add(word)

        extraction = {
            "반복_입력자료": patterns.get("반복_입력자료", []),
            "반복_산출물": patterns.get("반복_산출물", []),
            "절차_단계": patterns.get("절차_단계", []),
            "사례별_특이점": cases,
            "주요_키워드": list(keywords)[:20],
            "_sources": [p.name for p in docs],
            "_source_paths": [str(p) for p in docs],
            "_map_ok": True,
        }

        return [extraction]

    def _build_batch_text(self, batch: list[Path]) -> str:
        """Build concatenated text from a batch of docs (used by incremental mode)."""
        parts: list[str] = []
        for path in batch:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as exc:
                logger.warning("Cannot read %s: %s", path, exc)
                content = "(읽기 실패)"
            parts.append(f"--- {path.name} ---\n{content}")

            # Follow wikilinks up to max_depth=2
            if self._vault_root:
                linked = _resolve_wikilinks(content, self._vault_root, max_depth=2)
                for link_path, link_content in linked:
                    parts.append(f"--- [참조됨: {path.name} → {link_path.name}] ---\n{link_content}")

        return "\n\n".join(parts)

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

    # ── Incremental (single-pass) synthesis ──────────────────────

    def synthesize_incremental(
        self,
        docs: list[Path],
        existing_wiki: str | None = None,
        domain: str = "",
        cache_dir: Path | None = None,
    ) -> tuple[str, list[str]]:
        """Single-pass incremental synthesis: raw docs → wiki directly (no MAP phase).

        Each batch of raw documents is fed directly to the LLM along with the
        current wiki state.  The LLM generates MdDiff operations to integrate
        new information.  This avoids the 2-pass overhead of map-reduce and
        preserves original document detail better.

        Returns:
            Tuple of (wiki markdown string, list of successfully processed doc paths).
        """
        if not docs:
            logger.warning("synthesize_incremental() called with empty docs list")
            return (existing_wiki or "", [])

        # Smaller batch size for incremental — raw text is larger than pattern JSON
        inc_batch_size = min(10, self.batch_size)
        batches = self._batch(docs, inc_batch_size)
        wiki = existing_wiki or ""
        succeeded: list[str] = []

        inc_cache_dir: Path | None = None
        if cache_dir:
            inc_cache_dir = cache_dir / "incremental_cache"
            inc_cache_dir.mkdir(parents=True, exist_ok=True)

        for i, batch in enumerate(batches):
            cache_file = inc_cache_dir / f"step_{i}.md" if inc_cache_dir else None

            # Try loading cached wiki state
            if cache_file and cache_file.exists():
                try:
                    wiki = cache_file.read_text(encoding="utf-8")
                    logger.info("Incremental batch %d/%d loaded from cache", i + 1, len(batches))
                    succeeded.extend(str(p) for p in batch)
                    continue
                except Exception:
                    pass

            logger.info("Incremental batch %d/%d (%d docs)", i + 1, len(batches), len(batch))
            raw_text = self._build_batch_text(batch)
            source_list = "\n".join(f"- {p.name}" for p in batch)
            domain_line = f"도메인: {domain}\n\n" if domain else ""

            if not wiki:
                # First batch, no existing wiki → create from scratch
                system_prompt = INCREMENTAL_CREATE_SYSTEM_PROMPT.format(
                    structure_block=_build_structure_block(self.doc_structure),
                )
                user_prompt = (
                    f"{domain_line}"
                    f"=== raw 문서 ({len(batch)}건) ===\n\n{raw_text}\n\n"
                    f"=== 문서 목록 (각주용) ===\n{source_list}"
                )
                wiki = self.agent.generate(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
                wiki = strip_code_blocks(wiki)
            else:
                # Subsequent batches → update existing wiki via MdDiff
                nodes = md_to_json(wiki)
                nodes_json = json.dumps(
                    [n.model_dump() for n in nodes], ensure_ascii=False, indent=2,
                )
                user_prompt = (
                    f"{domain_line}"
                    f"기존 wiki (JSON 노드):\n{nodes_json}\n\n"
                    f"=== 신규 raw 문서 ({len(batch)}건) ===\n\n{raw_text}\n\n"
                    f"=== 이번 배치 문서 목록 (각주용) ===\n{source_list}"
                )
                diff_response = self.agent.generate(
                    system_prompt=INCREMENTAL_UPDATE_SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                )
                prev_wiki = wiki
                wiki = self._apply_section_diffs(wiki, diff_response)

                if wiki == prev_wiki:
                    logger.warning("Incremental batch %d produced no changes", i + 1)

            succeeded.extend(str(p) for p in batch)

            # Cache wiki state after this batch
            if cache_file:
                try:
                    cache_file.write_text(wiki, encoding="utf-8")
                except Exception:
                    logger.warning("Failed to write incremental cache for batch %d", i + 1)

        # Post-processing
        wiki = strip_code_blocks(wiki)
        wiki = filter_attachment_footnotes(wiki)

        logger.info("Incremental synthesis: %d/%d docs succeeded", len(succeeded), len(docs))
        return (wiki, succeeded)

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


# ── Wikilink resolution ──────────────────────────────────────────

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]")


def _resolve_wikilinks(
    content: str,
    vault_root: Path,
    max_depth: int = 2,
    _depth: int = 0,
    _seen: set[str] | None = None,
) -> list[tuple[Path, str]]:
    """Follow Obsidian wikilinks to .md files and return (path, content) pairs.

    - Only .md files are followed (non-md links are skipped)
    - Recurses up to max_depth levels
    - Deduplicates by filename to avoid cycles
    """
    if _depth >= max_depth:
        return []
    if _seen is None:
        _seen = set()

    results: list[tuple[Path, str]] = []
    links = _WIKILINK_RE.findall(content)

    for link_name in links:
        link_name = link_name.strip()
        if link_name in _seen:
            continue
        _seen.add(link_name)

        resolved = _find_in_vault(link_name, vault_root)
        if resolved is None or resolved.suffix.lower() != ".md":
            continue

        try:
            text = resolved.read_text(encoding="utf-8")
            results.append((resolved, text))
            if _depth + 1 < max_depth:
                results.extend(
                    _resolve_wikilinks(text, vault_root, max_depth, _depth + 1, _seen)
                )
        except Exception as exc:
            logger.debug("Cannot read linked %s: %s", resolved, exc)

    return results


def _find_in_vault(name: str, vault_root: Path) -> Path | None:
    """Find a file by name in the vault (Obsidian-style shortest match)."""
    if "." not in name.split("/")[-1]:
        name += ".md"

    direct = vault_root / name
    if direct.exists():
        return direct

    target = name.split("/")[-1]
    matches = list(vault_root.rglob(target))
    return matches[0] if matches else None


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


