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
    from .json_utils import try_parse_validated
except ImportError:
    from json_utils import try_parse_validated


class MapExtraction(BaseModel):
    반복_입력자료: list[str] = []
    반복_산출물: list[str] = []
    절차_단계: list[str] = []
    사례별_특이점: list[dict] = []
    주요_키워드: list[str] = []

logger = logging.getLogger(__name__)


# ── Prompts ───────────────────────────────────────────────────────

MAP_SYSTEM_PROMPT = """\
당신은 raw 업무 문서에서 반복 패턴을 추출하는 전문가입니다.
주어진 raw 문서 묶음을 분석하여 아래 구조의 JSON으로만 응답하세요.

{
  "반복_입력자료": ["항목1", "항목2", ...],
  "반복_산출물": ["항목1", "항목2", ...],
  "절차_단계": ["1. 단계", "2. 단계", ...],
  "사례별_특이점": [
    {"사례": "파일명 또는 사례 식별자", "특이사항": "설명"}
  ],
  "주요_키워드": ["키워드1", "키워드2", ...]
}

규칙:
- JSON 외 다른 텍스트를 출력하지 말 것
- raw 문서에 없는 내용을 추가하지 말 것 (hallucination 금지)
- 반복적으로 등장하는 패턴을 우선 추출할 것
"""

REDUCE_SYSTEM_PROMPT = """\
당신은 전문 wiki 작성자입니다.
여러 배치에서 추출한 패턴 JSON들을 종합하여 구조화된 wiki note를 작성합니다.

wiki note 형식:
1. YAML frontmatter (tags, created, domain, sources 포함)
2. ## 핵심 성격
3. ## 반복 패턴
   - ### 반복 입력자료
   - ### 반복 산출물
4. ## 절차
5. ## 대표 사례 (최소 3개, 각 사례에 각주 참조)
6. ## 열린 이슈 (불확실하거나 추가 확인이 필요한 항목)
7. 각주 섹션 (raw 문서 파일명 기반)

규칙:
- 각주는 Obsidian 표준 형식을 사용할 것:
  - 본문: [^1][^2] (숫자 기반, 짧게)
  - 문서 하단 ## 각주 섹션에 정의: [^1]: [[(안전성검토)_파일명]]
  - 각주 정의에서 .md 확장자는 제거할 것
- 모든 서술 문장에 각주를 달 것
- raw 데이터에 없는 내용을 추가하지 말 것 (hallucination 금지)
- 신규 담당자가 업무를 수행할 수 있도록 절차와 기준을 구체적으로 작성할 것
- 한국어로 작성할 것
"""

UPDATE_REDUCE_SYSTEM_PROMPT = """\
당신은 전문 wiki 업데이트 작성자입니다.
기존 wiki note에 새로 추출된 패턴 JSON들을 통합하여 wiki note를 갱신합니다.

규칙:
1. 기존 wiki의 구조, 섹션, 톤을 유지할 것
2. 새 패턴 정보를 적절한 섹션에 통합할 것
3. 각주는 Obsidian 표준 형식: 본문 [^숫자], 하단 [^숫자]: [[(파일명)]] (.md 제거)
4. 기존 각주 번호를 유지하고 새 각주는 이어서 번호를 매길 것
5. raw 데이터에 없는 내용을 추가하지 말 것 (hallucination 금지)
6. 중복 내용을 제거하고 최신 정보로 갱신할 것
7. 한국어로 작성할 것
"""


# ── ChunkedSynthesizer ────────────────────────────────────────────

class ChunkedSynthesizer:
    """Map-Reduce wiki synthesis from a large set of raw documents.

    Args:
        agent: Any object with a ``generate(system_prompt, user_prompt) -> str``
               method (e.g. WikiAgent, ChatGPTClient-based agent).
        batch_size: Number of documents processed per map step.
    """

    def __init__(self, agent, batch_size: int = 25) -> None:
        self.agent = agent
        self.batch_size = batch_size

    # ── Public API ────────────────────────────────────────────────

    def synthesize(
        self,
        docs: list[Path],
        existing_wiki: str | None = None,
        domain: str = "",
        reference_files: list[Path] | None = None,
    ) -> str:
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
            Synthesized wiki note as a Markdown string.
        """
        if not docs:
            logger.warning("synthesize() called with empty docs list")
            return existing_wiki or ""

        # Map phase
        extractions = self._map(docs)

        # Reduce phase
        if existing_wiki:
            return self._update_reduce(extractions, existing_wiki, docs, domain)
        return self._create_reduce(extractions, docs, domain)

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
        extraction = try_parse_validated(response, MapExtraction)
        if extraction:
            data = extraction.model_dump()
            data["_sources"] = sources
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
            }

    # ── Reduce phase ──────────────────────────────────────────────

    def _create_reduce(
        self, extractions: list[dict], docs: list[Path], domain: str
    ) -> str:
        """Reduce extractions into a new wiki note."""
        user_prompt = self._build_reduce_user_prompt(extractions, docs, domain)
        return self.agent.generate(
            system_prompt=REDUCE_SYSTEM_PROMPT,
            user_prompt=user_prompt,
        )

    def _update_reduce(
        self,
        extractions: list[dict],
        existing_wiki: str,
        docs: list[Path],
        domain: str,
    ) -> str:
        """Merge extractions into an existing wiki note."""
        extractions_text = _format_extractions(extractions)
        source_list = "\n".join(f"- {p.name}" for p in docs)
        domain_line = f"도메인: {domain}\n\n" if domain else ""

        user_prompt = (
            f"{domain_line}"
            f"=== 기존 wiki note ===\n{existing_wiki}\n\n"
            f"=== 새로 추출된 패턴 ({len(extractions)}개 배치) ===\n{extractions_text}\n\n"
            f"=== 추가된 raw 문서 목록 ===\n{source_list}"
        )
        return self.agent.generate(
            system_prompt=UPDATE_REDUCE_SYSTEM_PROMPT,
            user_prompt=user_prompt,
        )

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


