from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KARPATHY_DIR = ROOT / "src" / "catalog" / "methods" / "karpathy-loop"
WIKI_DIR = ROOT / "src" / "catalog" / "tasks" / "wiki"

for candidate in (str(KARPATHY_DIR), str(WIKI_DIR), str(ROOT / "src")):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from engine import run_loop, build_evaluation_from_spec  # type: ignore[import-not-found]
from agents import OpenAIAgents  # type: ignore[import-not-found]
from task import WikiTask  # type: ignore[import-not-found]
import task as wiki_task_module  # type: ignore[import-not-found]

from catalog.loaders.spec_loader import SpecLoader  # type: ignore[import-not-found]


logger = logging.getLogger(__name__)


LAYER1_ADDENDUM = """

## Layer 1 전용 강화 규칙 (Tobacco Law only)

1. 이 실행은 Tobacco Law 원문만 사용하는 1차 초안이다. Law Review나 규제준수 사례가 아직 없다고 가정하고,
   해석적 확장 대신 법문 중심의 초안을 작성하라.
2. 법률 원문에서 확인된 조항/수치/기한/예외/정의/적용 대상은 최대한 원형을 유지하라.
3. Layer 1에서는 실무 추정과 실무 패턴 출력을 금지한다. `[실무 패턴: ...]`, `실무`, `운영상`, `통상`, `론칭`, `실무 가이드라인`, `실무 절차`, `제출 사례` 같은 표현과 섹션을 만들지 마라.
4. 국가 wiki의 핵심 가치는 "초안의 충실도"다. 문장을 매끈하게 줄이는 것보다, 법률상 요건을 빠짐없이 담는 것을 우선하라.
5. 제출 유형이 명확하지 않더라도 관련 법 조항이 있으면 해당 제출 섹션에 배치하고, 근거가 약하면 "해당 없음 (분석 문서 내 언급 없음)" 대신
   "법률 원문 기준 직접 확인 필요"라고 쓰지 말고, raw에 있는 사실만 배치하라.
6. Obsidian callout과 blockquote를 사용하지 마라. `> [!info] Quick Actions` 같은 카드형 문법을 출력하지 마라.
7. 제출 섹션(신규/변경/정기)의 하위 내용은 반드시 제출 시기, 제출 대상 및 자료, 제출 방법 순서로만 정리하라.
   `#### 법적 근거` 같은 별도 근거 섹션을 만들지 마라.
8. 제품 규격 섹션의 제품군별 하위 구조는 JSONL 스펙에 정의된 헤딩을 따른다. 스펙에 없는 하위 섹션을 추가하지 마라.
9. 모든 주장과 bullet은 그 문장 자체 안에 근거조항을 포함해야 한다. 형식은 `...해야 한다 (법률명 §조항).[^1]`처럼 문장 끝에 법률명+조항과 각주를 함께 둔다. 근거를 따로 모아두는 방식은 금지한다.
10. `언제 / 무엇을 / 어떻게 / 왜(근거)`가 한 덩어리로 읽히도록 작성하라. 특히 `제출 시기`에서는 기한과 기산일 뒤에 즉시 조항을 붙이고, `제출 대상 및 자료`와 `제출 방법`에서도 각 항목마다 조항을 붙여라.
11. 제품군 구분이 필요하면 canonical 섹션 내부에서 `- **제품군명:** 내용` 또는 `- **제품군명**` + 하위 bullet 형식을 사용하라. 스펙에 없는 새 헤더를 만들지 말라.
12. 상위 bullet 아래의 하위 자료 목록도 가능하면 항목별 각주를 붙여라. 최소한 상위 주장 bullet은 반드시 각주와 조항을 함께 가져야 한다.
13. 한 규칙은 한 번만 쓴다. 같은 의미의 문장을 상위 bullet과 하위 bullet에서 반복하지 마라. 요약문과 재서술 bullet을 동시에 두지 마라.
14. 공통 규칙은 공통으로 한 번 쓰고, 제품군별 섹션에는 차이점과 예외만 적어라. 제품군별 내용이 완전히 같으면 같은 목록을 세 번 복제하지 말고, 공통 규정 적용이라고 짧게 연결하라.
15. `해당 없음 (분석 문서 내 언급 없음)`은 같은 제출유형 안에서 같은 이유를 반복하지 마라. 정말 필요한 경우 제품군당 한 번만 쓰고, 가능하면 `별도 규정 미확인`처럼 짧게 끝내라.
16. `제출 대상 및 자료`에서는 장문 쉼표 나열을 피하고, 제출 패키지를 3~7개의 의미 단위로 묶어라. 예: 식별정보, 성분/배출, 독성자료, 제품설명/포장, 책임선언.
17. `제출 방법`은 절차 동사 중심으로 짧게 쓴다. `제출한다`, `첨부한다`, `허가를 신청한다`, `승인 후 출시한다`처럼 바로 행동으로 읽혀야 한다.
18. 제품군에 별도 규정이 약하면 억지로 채우지 말고, 공통 규정 적용 범위와 별도 규정 미확인 범위를 분리해서 한 문장으로 명확히 써라.
19. quote와 legal_basis가 있는 claim은 가능한 한 본문에 직접 녹여서, 후속 Layer 2가 덮어쓰기 쉽게 만들라.
"""

DEFAULT_SPEC_PATH = (
    Path.home()
    / "Projects/nextboat-information"
    / "desktop/tauri-app/src/features/information/specs/domainSpecs.jsonl"
)

PROMPT_SURFACE_VERSION = "v1"


def _tree_to_headings(tree: dict) -> list[str]:
    """Flatten JSONL structure tree into ordered markdown heading lines."""
    headings: list[str] = []

    def _walk(node: dict) -> None:
        for section in node.get("sections", {}).values():
            if isinstance(section, dict):
                title = section.get("title")
                level = section.get("level", 1)
                if title:
                    headings.append(f"{'#' * (level + 1)} {title}")
                _walk(section)

    struct = tree.get("structure", tree)
    _walk(struct)
    return headings


def _copy_if_requested(
    final_file: Path | None, vault_root: Path, copy_to: str | None
) -> Path | None:
    if not final_file or not final_file.exists() or not copy_to:
        return None
    destination = vault_root / copy_to
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(final_file, destination)
    return destination


def _load_all_specs(spec_path: Path, domain: str, layer: str) -> dict:
    """Load all spec entries from JSONL via SpecLoader.

    Returns a dict with keys 'spec_extract_prompt', 'spec_compose_prompt',
    'spec_eval_config', 'doc_structure'. Missing entries are omitted.
    """
    loader = SpecLoader(spec_path=spec_path)
    overrides: dict = {}

    extract_prompt = loader.load_extract_prompt(domain, layer)
    if extract_prompt:
        overrides["spec_extract_prompt"] = extract_prompt

    compose_prompt = loader.load_compose_prompt(domain, layer)
    if compose_prompt:
        overrides["spec_compose_prompt"] = compose_prompt

    eval_config = loader.load_evaluation(domain, layer)
    if eval_config:
        overrides["spec_eval_config"] = eval_config

    structure_specs = loader.load_specs(domain, "")
    structure_entry = structure_specs.get("structure")
    if structure_entry and "tree" in structure_entry:
        headings = _tree_to_headings(structure_entry["tree"])
        if headings:
            overrides["doc_structure"] = headings

    return overrides


def run_layer1_country(
    *,
    country: str,
    base_path: str,
    vault_root: Path,
    output_dir: Path,
    model: str | None,
    copy_to: str | None,
    extra_addendum_path: Path | None,
    spec_path: Path,
) -> Path | None:
    output_dir.mkdir(parents=True, exist_ok=True)
    resolved_base_path = Path(base_path).expanduser()
    if not resolved_base_path.is_absolute():
        resolved_base_path = (vault_root / resolved_base_path).resolve()

    original_addendum = wiki_task_module.COUNTRY_RULES_ADDENDUM
    extra_addendum = ""
    if extra_addendum_path:
        extra_addendum = extra_addendum_path.read_text(encoding="utf-8").strip()

    wiki_task_module.COUNTRY_RULES_ADDENDUM = (
        original_addendum.rstrip()
        + "\n"
        + LAYER1_ADDENDUM.rstrip()
        + ("\n" + extra_addendum if extra_addendum else "")
    )

    spec_data = _load_all_specs(spec_path, "regulation", "layer1")

    eval_config = spec_data.get("spec_eval_config")
    if not eval_config:
        raise ValueError(
            f"Spec at '{spec_path}' has no layer1.evaluation entry for "
            "domain=regulation layer=layer1. "
            "Layer 1 requires evaluation config from spec."
        )

    doc_structure = spec_data.get("doc_structure")
    if not doc_structure:
        logger.warning(
            "No doc_structure found in spec structure entry; "
            "synthesizer will use default headings."
        )

    parsed_evaluation = build_evaluation_from_spec(eval_config)
    parsed_evaluation.extra_config["doc_structure"] = doc_structure

    context_config: dict = {
        "country": country,
        "layer": "tobacco_law",
        "base_path": str(resolved_base_path),
        "vault_root": str(vault_root),
        "_parsed_evaluation_override": parsed_evaluation,
    }
    context_config.update({k: v for k, v in spec_data.items() if k.startswith("spec_")})

    try:
        agents = OpenAIAgents(model=model) if model else OpenAIAgents()
        report = run_loop(
            WikiTask(),
            None,
            input_files=[],
            reference_files=[],
            agents=agents,
            output_dir=output_dir,
            context_config=context_config,
        )
    finally:
        wiki_task_module.COUNTRY_RULES_ADDENDUM = original_addendum

    logger.info(
        "Layer 1 loop finished: status=%s final_score=%s",
        report.status,
        report.final_score,
    )

    final_file: Path | None = None
    if report.output_files:
        final_file = report.output_files[0]
    else:
        final_dir = output_dir / "final"
        if final_dir.exists():
            finals = sorted(p for p in final_dir.iterdir() if p.is_file())
            if finals:
                final_file = finals[0]

    copied = _copy_if_requested(final_file, vault_root, copy_to)
    if copied:
        logger.info("Copied Layer 1 output to %s", copied)

    return final_file


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Layer 1 country wiki runner (spec-driven)"
    )
    parser.add_argument("--country", required=True, help="Country key, e.g. taiwan")
    parser.add_argument(
        "--base", required=True, help=".base path relative to vault root"
    )
    parser.add_argument(
        "--vault-root", required=True, type=Path, help="Obsidian vault root"
    )
    parser.add_argument(
        "--output", required=True, type=Path, help="Output work directory"
    )
    parser.add_argument("--model", default=None, help="LLM model override")
    parser.add_argument(
        "--copy-to",
        default=None,
        help="Vault-root-relative destination to copy final Layer 1 markdown",
    )
    parser.add_argument(
        "--extra-addendum-file",
        type=Path,
        default=None,
        help="Optional extra prompt addendum file appended at runtime",
    )
    parser.add_argument(
        "--spec-path",
        type=Path,
        default=None,
        help="Path to domainSpecs.jsonl (default: auto-discovered)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable debug logging"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    spec_path = args.spec_path or DEFAULT_SPEC_PATH
    if not spec_path.is_file():
        logger.error("Spec file not found: %s", spec_path)
        raise SystemExit(1)

    result = run_layer1_country(
        country=args.country,
        base_path=args.base,
        vault_root=args.vault_root.expanduser().resolve(),
        output_dir=args.output,
        model=args.model,
        copy_to=args.copy_to,
        extra_addendum_path=args.extra_addendum_file,
        spec_path=spec_path,
    )

    if result and result.exists():
        print(f"Layer 1 wiki completed: {result}")
        return

    print("Layer 1 wiki generation failed")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
