#!/usr/bin/env python3
"""Full pipeline test: Codex MAP → REDUCE → wiki MD.

Runs the complete Codex MAP on 5 docs, then feeds results into
the existing REDUCE phase to produce a final wiki markdown file.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, "src")
sys.path.insert(0, "src/catalog/tasks/wiki")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("codex_pipeline")

from base_index import BaseIndexParser
from synthesizer import ChunkedSynthesizer, strip_code_blocks, filter_attachment_footnotes
from task import WikiAgent
from catalog.sdk_profiles.codex_oauth import run_codex_prompt

# ── Config ────────────────────────────────────────────────────────

VAULT = Path.home() / "Documents" / "Mywork"
BASE_PATH = VAULT / "3. Resource" / "LLM Knowledge Base" / "index" / "첨가물정보 제출.base"
ONEDRIVE = Path.home() / "Library" / "CloudStorage" / "OneDrive-ktng.com"
OUTPUT_DIR = Path("/tmp/codex_map_test")

CLAIM_SCHEMA = {
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

DOC_STRUCTURE = [
    "## 업무 개요",
    "## 신규제출",
    "### {국가}",
    "## 변경제출",
    "### {국가}",
    "## 정기제출",
    "### {국가}",
    "## 공통 이슈사항",
    "## 신규 담당자 체크리스트",
    "## 열린 이슈 (불확실하거나 추가 확인이 필요한 항목)",
]


# ── Step 1: Codex MAP ─────────────────────────────────────────────

def run_codex_map(docs: list[Path]) -> dict:
    """Run Codex MAP and return parsed claims JSON."""
    doc_listing = "\n".join(f"- {p}" for p in docs)

    prompt = f"""당신은 문서 분석 오케스트레이터입니다.
아래 {len(docs)}개 문서에서 반복 패턴과 개별 claim을 추출하세요.

문서 경로 목록:
{doc_listing}

작업 절차:
1. 각 문서를 cat으로 읽으세요
2. 각 문서에서 핵심 사실/절차/이슈를 claim으로 추출하세요
3. 중복되는 claim은 병합하고 doc_id 목록을 통합하세요
4. 반복 패턴 (입력자료, 산출물, 절차 단계)을 정리하세요
5. 모든 문서 처리 후 최종 JSON을 반환하세요

각 claim에 반드시 포함할 필드:
- claim: 핵심 사실 (한국어)
- quote: 원문 근거 1-2문장
- doc_id: 파일명
- section_target: 이 claim이 들어갈 wiki 섹션 (예: "## 절차", "## 열린 이슈")
- confidence: high/medium/low

원문에 없는 내용은 절대 추가하지 마세요."""

    logger.info("Codex MAP: %d docs 전송...", len(docs))
    start = time.time()

    result = run_codex_prompt(
        prompt=prompt,
        cwd=str(Path.cwd()),
        reasoning_effort="high",
        output_schema=CLAIM_SCHEMA,
        timeout_s=600.0,
    )

    elapsed = time.time() - start
    logger.info("Codex MAP 완료: %.1fs (ok=%s)", elapsed, result["ok"])

    if not result["ok"]:
        raise RuntimeError(f"Codex MAP failed: {result['message']}")

    return json.loads(result["output"])


# ── Step 2: Claims → Extraction format ───────────────────────────

def claims_to_extraction(claims_data: dict, docs: list[Path]) -> list[dict]:
    """Convert Codex claims JSON to existing MAP extraction format."""
    patterns = claims_data.get("patterns", {})
    claims = claims_data.get("claims", [])

    # Convert claims to 사례별_특이점 format
    cases = []
    keywords = set()
    for c in claims:
        cases.append({
            "사례": c.get("doc_id", ""),
            "특이사항": f"{c['claim']} — \"{c.get('quote', '')}\"",
            "section_target": c.get("section_target", ""),
            "confidence": c.get("confidence", "medium"),
        })
        # Extract keywords from claim text
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


# ── Step 3: REDUCE → wiki ────────────────────────────────────────

def reduce_to_wiki(extractions: list[dict], docs: list[Path], domain: str) -> str:
    """Use existing ChunkedSynthesizer REDUCE to produce wiki MD."""
    agent = WikiAgent()
    synth = ChunkedSynthesizer(agent, doc_structure=DOC_STRUCTURE, vault_root=VAULT)

    logger.info("REDUCE: %d extractions → wiki 생성...", len(extractions))
    start = time.time()

    wiki = synth._create_reduce(extractions, docs, domain)
    wiki = strip_code_blocks(wiki)
    wiki = filter_attachment_footnotes(wiki)

    elapsed = time.time() - start
    logger.info("REDUCE 완료: %.1fs, %d줄", elapsed, len(wiki.splitlines()))

    return wiki


# ── Main ─────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Codex MAP → REDUCE → wiki full pipeline")
    parser.add_argument("--max-docs", type=int, default=5)
    parser.add_argument("--use-cached", action="store_true", help="Use cached Codex MAP result")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Discover docs
    logger.info("=== 문서 검색 ===")
    idx_parser = BaseIndexParser(VAULT)
    all_docs = idx_parser.discover(BASE_PATH, filter_pattern="(규제준수)_*.md")
    docs = all_docs[:args.max_docs]
    logger.info("%d개 문서 선택 (전체 %d개)", len(docs), len(all_docs))
    for d in docs:
        logger.info("  - %s", d.name)

    # 2. Codex MAP (or use cached)
    cached_claims = OUTPUT_DIR / "codex_claims.json"
    if args.use_cached and cached_claims.exists():
        logger.info("=== 캐시된 Codex MAP 결과 사용 ===")
        claims_data = json.loads(cached_claims.read_text(encoding="utf-8"))
    else:
        logger.info("=== Codex MAP 실행 ===")
        claims_data = run_codex_map(docs)
        cached_claims.write_text(json.dumps(claims_data, ensure_ascii=False, indent=2), encoding="utf-8")

    logger.info("Claims: %d개, Patterns: %s",
                len(claims_data.get("claims", [])),
                {k: len(v) for k, v in claims_data.get("patterns", {}).items()})

    # 3. Convert to extraction format
    logger.info("=== Claims → Extraction 변환 ===")
    extractions = claims_to_extraction(claims_data, docs)

    # 4. REDUCE → wiki
    logger.info("=== REDUCE → Wiki 생성 ===")
    wiki = reduce_to_wiki(extractions, docs, "첨가물정보제출")

    # 5. Save
    # Local
    local_path = OUTPUT_DIR / "첨가물정보제출_codex_map.md"
    local_path.write_text(wiki, encoding="utf-8")
    logger.info("로컬 저장: %s", local_path)

    # OneDrive
    onedrive_path = ONEDRIVE / "첨가물정보제출_codex_map_test.md"
    onedrive_path.write_text(wiki, encoding="utf-8")
    logger.info("OneDrive 저장: %s", onedrive_path)

    # Also save to wiki dir for comparison
    wiki_dir = VAULT / "3. Resource" / "LLM Knowledge Base" / "wiki"
    wiki_compare_path = wiki_dir / "첨가물정보제출_codex_map.md"
    wiki_compare_path.write_text(wiki, encoding="utf-8")
    logger.info("Wiki 폴더 저장 (비교용): %s", wiki_compare_path)

    print(f"\n{'='*60}")
    print(f"PIPELINE COMPLETE")
    print(f"{'='*60}")
    print(f"문서 수: {len(docs)}")
    print(f"Claims: {len(claims_data.get('claims', []))}개")
    print(f"Wiki 길이: {len(wiki.splitlines())}줄 / {len(wiki)}자")
    print(f"\n저장 위치:")
    print(f"  로컬: {local_path}")
    print(f"  OneDrive: {onedrive_path}")
    print(f"  Wiki 비교: {wiki_compare_path}")
    print(f"\n{'='*60}")
    print(f"WIKI PREVIEW (첫 50줄):")
    print(f"{'='*60}")
    for line in wiki.splitlines()[:50]:
        print(line)
    print("...")


if __name__ == "__main__":
    main()
