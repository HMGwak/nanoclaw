#!/usr/bin/env python3
"""Standalone test: Codex SDK MAP vs 기존 MAP 성능 비교.

본 코드 수정 없이 독립 실행. Codex 에이전트 기반 MAP의 claim 품질을 평가.

Usage:
    python3 test_codex_map.py                  # Codex MAP만 실행
    python3 test_codex_map.py --compare        # 기존 MAP과 비교
    python3 test_codex_map.py --max-docs 5     # 문서 수 제한
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
logger = logging.getLogger("test_codex_map")

from base_index import BaseIndexParser
from catalog.sdk_profiles.codex_oauth import run_codex_prompt, check_runtime

# ── Config ────────────────────────────────────────────────────────

VAULT = Path.home() / "Documents" / "Mywork"
BASE_PATH = VAULT / "3. Resource" / "LLM Knowledge Base" / "index" / "첨가물정보 제출.base"
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


# ── Codex MAP ─────────────────────────────────────────────────────

def codex_map(docs: list[Path], cwd: str | None = None) -> dict:
    """Run Codex MAP: send docs to Codex orchestrator → get structured claims."""
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

    logger.info("Sending %d docs to Codex MAP...", len(docs))
    start = time.time()

    result = run_codex_prompt(
        prompt=prompt,
        cwd=cwd or str(Path.cwd()),
        reasoning_effort="high",
        output_schema=CLAIM_SCHEMA,
        timeout_s=600.0,
    )

    elapsed = time.time() - start
    logger.info("Codex MAP completed in %.1fs (ok=%s)", elapsed, result["ok"])

    return {
        "ok": result["ok"],
        "code": result["code"],
        "elapsed_s": round(elapsed, 1),
        "output": result["output"],
        "message": result["message"],
    }


# ── Legacy MAP (기존 방식) ────────────────────────────────────────

def legacy_map(docs: list[Path]) -> dict:
    """Run legacy MAP via existing synthesizer for comparison."""
    from synthesizer import ChunkedSynthesizer, MapExtraction

    # Use ChatGPT OAuth agent
    from task import WikiAgent
    agent = WikiAgent()
    synth = ChunkedSynthesizer(agent, batch_size=10)

    logger.info("Running legacy MAP on %d docs...", len(docs))
    start = time.time()
    extractions = synth._map(docs)
    elapsed = time.time() - start
    logger.info("Legacy MAP completed in %.1fs (%d batches)", elapsed, len(extractions))

    return {
        "elapsed_s": round(elapsed, 1),
        "extractions": extractions,
        "batch_count": len(extractions),
    }


# ── Quality metrics ──────────────────────────────────────────────

def evaluate_codex_claims(output: str, docs: list[Path]) -> dict:
    """Evaluate Codex MAP output quality."""
    try:
        data = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        # Try to extract JSON from text
        import re
        match = re.search(r'\{[\s\S]*\}', output or "")
        if match:
            try:
                data = json.loads(match.group())
            except json.JSONDecodeError:
                return {"parse_error": True, "raw_preview": (output or "")[:500]}
        else:
            return {"parse_error": True, "raw_preview": (output or "")[:500]}

    claims = data.get("claims", [])
    patterns = data.get("patterns", {})
    doc_names = {p.name for p in docs}

    # Coverage: how many source docs are referenced in claims
    referenced_docs = {c.get("doc_id", "") for c in claims}
    covered = referenced_docs & doc_names
    coverage_pct = (len(covered) / len(doc_names) * 100) if doc_names else 0

    # Confidence distribution
    conf_dist = {"high": 0, "medium": 0, "low": 0}
    for c in claims:
        conf = c.get("confidence", "low")
        conf_dist[conf] = conf_dist.get(conf, 0) + 1

    # Section distribution
    sections = {}
    for c in claims:
        sec = c.get("section_target", "unknown")
        sections[sec] = sections.get(sec, 0) + 1

    # Quote presence
    has_quote = sum(1 for c in claims if c.get("quote"))

    return {
        "parse_error": False,
        "total_claims": len(claims),
        "doc_coverage_pct": round(coverage_pct, 1),
        "covered_docs": len(covered),
        "total_docs": len(doc_names),
        "uncovered_docs": sorted(doc_names - referenced_docs),
        "confidence_distribution": conf_dist,
        "section_distribution": sections,
        "claims_with_quote": has_quote,
        "claims_without_quote": len(claims) - has_quote,
        "patterns": {
            "반복_입력자료": len(patterns.get("반복_입력자료", [])),
            "반복_산출물": len(patterns.get("반복_산출물", [])),
            "절차_단계": len(patterns.get("절차_단계", [])),
        },
    }


def compare_results(codex_metrics: dict, legacy_result: dict, docs: list[Path]) -> dict:
    """Compare Codex MAP vs legacy MAP results."""
    legacy_ext = legacy_result["extractions"]

    # Count total unique items from legacy
    all_inputs = set()
    all_outputs = set()
    all_steps = []
    all_cases = []
    for ext in legacy_ext:
        all_inputs.update(ext.get("반복_입력자료", []))
        all_outputs.update(ext.get("반복_산출물", []))
        if ext.get("절차_단계"):
            all_steps = ext["절차_단계"]  # last batch wins
        all_cases.extend(ext.get("사례별_특이점", []))

    return {
        "codex": {
            "elapsed_s": codex_metrics.get("elapsed_s", "N/A"),
            "total_claims": codex_metrics.get("total_claims", 0),
            "doc_coverage_pct": codex_metrics.get("doc_coverage_pct", 0),
            "patterns": codex_metrics.get("patterns", {}),
        },
        "legacy": {
            "elapsed_s": legacy_result["elapsed_s"],
            "batch_count": legacy_result["batch_count"],
            "unique_inputs": len(all_inputs),
            "unique_outputs": len(all_outputs),
            "procedure_steps": len(all_steps),
            "cases": len(all_cases),
        },
    }


# ── Main ─────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Codex MAP test")
    parser.add_argument("--compare", action="store_true", help="Also run legacy MAP for comparison")
    parser.add_argument("--max-docs", type=int, default=10, help="Max docs to process")
    parser.add_argument("--save", action="store_true", help="Save results to OUTPUT_DIR")
    args = parser.parse_args()

    # 1. Health check
    logger.info("=== Codex Runtime Health Check ===")
    health = check_runtime()
    if not health.get("ok"):
        logger.error("Codex runtime not available: %s", health.get("message"))
        sys.exit(1)
    logger.info("Runtime OK: %s", health.get("details", {}).get("codex_path", "?"))

    # 2. Discover docs
    logger.info("=== Discovering 첨가물정보제출 documents ===")
    idx_parser = BaseIndexParser(VAULT)
    all_docs = idx_parser.discover(BASE_PATH, filter_pattern="(규제준수)_*.md")
    docs = all_docs[:args.max_docs]
    logger.info("Found %d total docs, using %d", len(all_docs), len(docs))
    for d in docs:
        logger.info("  - %s", d.name)

    # 3. Run Codex MAP
    logger.info("=== Running Codex MAP ===")
    codex_result = codex_map(docs)

    if not codex_result["ok"]:
        logger.error("Codex MAP failed: %s", codex_result["message"])
        if args.save:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            (OUTPUT_DIR / "codex_error.json").write_text(
                json.dumps(codex_result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        sys.exit(1)

    # 4. Evaluate
    logger.info("=== Evaluating Codex MAP Results ===")
    metrics = evaluate_codex_claims(codex_result["output"], docs)
    metrics["elapsed_s"] = codex_result["elapsed_s"]

    print("\n" + "=" * 60)
    print("CODEX MAP RESULTS")
    print("=" * 60)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))

    # 5. Save results
    if args.save:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUTPUT_DIR / "codex_claims.json").write_text(codex_result["output"] or "{}", encoding="utf-8")
        (OUTPUT_DIR / "codex_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Results saved to %s", OUTPUT_DIR)

    # 6. Compare with legacy
    if args.compare:
        logger.info("=== Running Legacy MAP for Comparison ===")
        legacy_result = legacy_map(docs)
        comparison = compare_results(metrics, legacy_result, docs)

        print("\n" + "=" * 60)
        print("COMPARISON: CODEX vs LEGACY")
        print("=" * 60)
        print(json.dumps(comparison, ensure_ascii=False, indent=2))

        if args.save:
            (OUTPUT_DIR / "comparison.json").write_text(
                json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    print("\nDone!")


if __name__ == "__main__":
    main()
