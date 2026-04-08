"""Legacy MAP implementation — 배치 기반 패턴 추출.

2026-04-08 Codex SDK MAP으로 대체됨.
보존 목적: 롤백 또는 비교 테스트 시 참조.

=== 작동 원리 ===

1. 문서를 batch_size(기본 10~30, 모델별 적응) 단위로 분할
2. 각 배치마다 agent.generate()를 호출하여 MAP_SYSTEM_PROMPT로 패턴 추출
3. LLM이 JSON으로 반환:
   - 반복_입력자료: 배치 내 반복되는 입력 자료 목록
   - 반복_산출물: 배치 내 반복되는 산출물 목록
   - 절차_단계: 공통 절차 단계
   - 사례별_특이점: 개별 문서의 특이사항
   - 주요_키워드: 핵심 키워드
4. 각 배치 결과를 리스트로 누적 → REDUCE 단계로 전달
5. 캐시 지원: cache_dir/map_cache/batch_{i}.json

=== 한계 (Codex MAP 대체 이유) ===

- 배치 내 패턴만 추출 → 배치 간 교차 패턴 미포착
- 원문 quote 미보존 (패턴 요약만 반환)
- 배치 수 × LLM 호출 = 비용/시간 증가
- 30개 문서 기준 3회 호출, 각 호출이 독립적으로 컨텍스트 손실

=== Codex MAP과의 차이 ===

| 항목 | Legacy MAP | Codex MAP |
|------|-----------|-----------|
| 호출 방식 | 배치별 agent.generate() N회 | Codex SDK 1회 (서브에이전트 병렬) |
| 교차 패턴 | 배치 내만 | 전체 문서 교차 |
| 원문 인용 | 없음 (패턴 요약) | quote 필드 포함 |
| 출력 형태 | MapExtraction JSON | Claim JSON (claim, quote, doc_id, section_target) |
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class MapExtraction(BaseModel):
    반복_입력자료: list[str] = []
    반복_산출물: list[str] = []
    절차_단계: list[str] = []
    사례별_특이점: list[dict] = []
    주요_키워드: list[str] = []


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


def try_parse_validated(response: str, model_cls):
    """Try to parse JSON from response and validate with Pydantic model."""
    # Strip code blocks
    cleaned = re.sub(r"```(?:json)?\s*", "", response)
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    try:
        data = json.loads(cleaned)
        return model_cls.model_validate(data)
    except Exception:
        return None


def legacy_map(
    agent,
    docs: list[Path],
    batch_size: int = 10,
    cache_dir: Path | None = None,
    vault_root: Path | None = None,
) -> list[dict]:
    """Legacy MAP: 배치별 agent.generate() 호출로 패턴 추출.

    Args:
        agent: .generate(system_prompt, user_prompt) 메서드를 가진 에이전트
        docs: raw 문서 경로 리스트
        batch_size: 배치 크기
        cache_dir: 캐시 디렉토리 (선택)
        vault_root: Obsidian vault 루트 (wikilink 해석용)

    Returns:
        배치별 extraction dict 리스트
    """
    batches = [docs[i:i + batch_size] for i in range(0, len(docs), batch_size)]
    extractions: list[dict] = []
    map_cache_dir: Path | None = None
    if cache_dir:
        map_cache_dir = cache_dir / "map_cache"
        map_cache_dir.mkdir(parents=True, exist_ok=True)

    for i, batch in enumerate(batches):
        cache_file = map_cache_dir / f"batch_{i}.json" if map_cache_dir else None

        # Try loading from cache
        if cache_file and cache_file.exists():
            try:
                cached = json.loads(cache_file.read_text(encoding="utf-8"))
                logger.info("Map batch %d/%d loaded from cache", i + 1, len(batches))
                extractions.append(cached)
                continue
            except Exception:
                pass

        logger.info("Map batch %d/%d (%d docs)", i + 1, len(batches), len(batch))

        # Build batch text
        parts: list[str] = []
        for path in batch:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as exc:
                logger.warning("Cannot read %s: %s", path, exc)
                content = "(읽기 실패)"
            parts.append(f"--- {path.name} ---\n{content}")
        raw_text = "\n\n".join(parts)

        response = agent.generate(
            system_prompt=MAP_SYSTEM_PROMPT,
            user_prompt=f"=== 배치 {i + 1} / {len(batches)} ===\n\n{raw_text}",
        )

        # Parse response
        sources = [p.name for p in batch]
        source_paths = [str(p) for p in batch]
        extraction = try_parse_validated(response, MapExtraction)
        if extraction:
            data = extraction.model_dump()
            data["_sources"] = sources
            data["_source_paths"] = source_paths
            data["_map_ok"] = True
        else:
            logger.warning("Map response parse failed, using empty extraction")
            data = {
                "반복_입력자료": [],
                "반복_산출물": [],
                "절차_단계": [],
                "사례별_특이점": [],
                "주요_키워드": [],
                "_sources": sources,
                "_source_paths": source_paths,
                "_map_ok": False,
            }
        extractions.append(data)

        # Save to cache
        if cache_file:
            try:
                cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                logger.warning("Failed to write map cache for batch %d", i + 1)

    return extractions
