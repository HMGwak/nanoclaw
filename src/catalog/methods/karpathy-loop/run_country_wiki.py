"""3-Layer Country Wiki 오케스트레이터.

사용법:
  python run_country_wiki.py --country taiwan \
    --base "3. Resource/LLM Knowledge Base/index/tobacco_regulation.base" \
    --vault-root ~/Documents/Mywork \
    --output /tmp/country_wiki/taiwan \
    --wiki-output-dir "3. Resource/LLM Knowledge Base/wiki/countries"

실행 흐름:
  Layer 1 (Tobacco Law) → run_loop() → wiki v1
  Layer 2 (Law Reviews)  → run_loop() with wiki v1 → wiki v2
  Layer 3 (규제준수 사례)  → run_loop() with wiki v2 → wiki v3
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
for candidate in (str(ROOT / "src"),):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

try:
    from .engine import run_loop, build_evaluation_from_spec
    from .agents import OpenAIAgents
except ImportError:
    from engine import run_loop, build_evaluation_from_spec  # type: ignore[no-redef]
    from agents import OpenAIAgents  # type: ignore[no-redef]

from catalog.loaders.spec_loader import SpecLoader  # type: ignore[import-not-found]

# WikiTask는 별도 패키지
_wiki_task_path = str(Path(__file__).parent.parent.parent / "tasks" / "wiki")
if _wiki_task_path not in sys.path:
    sys.path.insert(0, _wiki_task_path)

try:
    from catalog.tasks.wiki.task import WikiTask
except ImportError:
    from task import WikiTask  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

LAYERS = [
    {"name": "tobacco_law", "label": "Layer 1: Tobacco Law"},
    {"name": "law_review", "label": "Layer 2: Law Reviews"},
    {"name": "compliance", "label": "Layer 3: 규제준수 사례"},
]

RUBRIC_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "tasks"
    / "wiki"
    / "rubrics"
    / "rubric_country.md"
)

DEFAULT_SPEC_PATH = (
    Path.home()
    / "Projects/nextboat-information"
    / "desktop/tauri-app/src/features/information/specs/domainSpecs.jsonl"
)

LAYER_TO_SPEC = {
    "tobacco_law": "layer1",
    "law_review": "layer2",
    "compliance": "layer3",
}

PROMPT_SURFACE_VERSION = "v2"


def _tree_to_headings(tree: dict) -> list[str]:
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


def _load_all_specs(spec_path: Path, domain: str, layer: str) -> dict:
    loader = SpecLoader(spec_path=spec_path)
    overrides: dict = {}

    extract_prompt = loader.load_extract_prompt(domain, layer)
    if extract_prompt:
        overrides["spec_extract_prompt"] = extract_prompt

    compose_prompt = loader.load_compose_prompt(domain, layer)
    if compose_prompt:
        overrides["spec_compose_prompt"] = compose_prompt

    update_prompt = loader.load_update_prompt(domain, layer)
    if update_prompt:
        overrides["spec_update_prompt"] = update_prompt

    revise_prompt = loader.load_revise_prompt(domain, layer)
    if revise_prompt:
        overrides["spec_revise_prompt"] = revise_prompt

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


def run_country_wiki(
    country: str,
    base_path: str,
    vault_root: Path,
    output_dir: Path,
    wiki_output_dir: str | None = None,
    model: str | None = None,
    spec_path: Path | None = None,
) -> Path | None:
    """3-Layer 순차 실행으로 국가 wiki를 생성한다.

    Args:
        country: 국가 키 (예: "taiwan")
        base_path: .base 파일 경로 (vault_root 상대)
        vault_root: Obsidian vault 루트
        output_dir: 각 레이어의 작업 디렉토리
        wiki_output_dir: 최종 wiki 출력 디렉토리 (vault_root 상대)
        model: LLM 모델명 (기본값: 환경변수 또는 gpt-5.4)

    Returns:
        최종 wiki 파일 경로 또는 None
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    agents = OpenAIAgents(model=model) if model else OpenAIAgents()
    task = WikiTask()
    resolved_spec_path = spec_path or DEFAULT_SPEC_PATH

    previous_wiki_path: Path | None = None

    for layer_info in LAYERS:
        layer_name = layer_info["name"]
        layer_label = layer_info["label"]
        layer_dir = output_dir / layer_name

        logger.info("=== %s 시작 ===", layer_label)

        # reference_files: 이전 레이어 wiki 결과
        reference_files: list[Path] = []
        if previous_wiki_path and previous_wiki_path.exists():
            reference_files = [previous_wiki_path]

        context_config = {
            "country": country,
            "layer": layer_name,
            "base_path": base_path,
            "vault_root": str(vault_root),
            "wiki_output_dir": wiki_output_dir,
        }

        spec_layer = LAYER_TO_SPEC.get(layer_name)
        if spec_layer and resolved_spec_path.exists():
            spec_data = _load_all_specs(resolved_spec_path, "regulation", spec_layer)
            eval_config = spec_data.get("spec_eval_config")
            if eval_config:
                parsed_evaluation = build_evaluation_from_spec(eval_config)
                parsed_evaluation.extra_config["doc_structure"] = spec_data.get(
                    "doc_structure"
                )
                context_config["_parsed_evaluation_override"] = parsed_evaluation
            context_config.update(
                {k: v for k, v in spec_data.items() if k.startswith("spec_")}
            )
            if spec_data.get("doc_structure"):
                context_config["doc_structure"] = spec_data["doc_structure"]

        report = run_loop(
            task=task,
            rubric_path=None
            if context_config.get("_parsed_evaluation_override") is not None
            else RUBRIC_PATH,
            input_files=[],  # WikiTask가 자체 discover
            reference_files=reference_files,
            agents=agents,
            output_dir=layer_dir,
            context_config=context_config,
        )

        logger.info(
            "=== %s 완료: status=%s, score=%s ===",
            layer_label,
            report.status,
            report.final_score,
        )

        # 다음 레이어의 reference로 사용할 wiki 경로 탐색
        if report.output_files:
            previous_wiki_path = report.output_files[0]
        else:
            # final/ 디렉토리에서 찾기
            final_dir = layer_dir / "final"
            if final_dir.exists():
                finals = sorted(final_dir.iterdir())
                if finals:
                    previous_wiki_path = finals[0]

    # 최종 wiki를 wiki_output_dir에 복사
    if previous_wiki_path and previous_wiki_path.exists() and wiki_output_dir:
        dest = vault_root / wiki_output_dir / f"{country}.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(previous_wiki_path, dest)
        logger.info("Final wiki copied to: %s", dest)

    return previous_wiki_path


def main():
    parser = argparse.ArgumentParser(description="3-Layer Country Wiki Generator")
    parser.add_argument("--country", required=True, help="국가 키 (예: taiwan)")
    parser.add_argument(
        "--base", required=True, help=".base 파일 경로 (vault_root 상대)"
    )
    parser.add_argument(
        "--vault-root", required=True, type=Path, help="Obsidian vault 루트 경로"
    )
    parser.add_argument("--output", required=True, type=Path, help="작업 디렉토리")
    parser.add_argument(
        "--wiki-output-dir",
        default=None,
        help="최종 wiki 출력 디렉토리 (vault_root 상대)",
    )
    parser.add_argument("--model", default=None, help="LLM 모델명")
    parser.add_argument(
        "--spec-path",
        type=Path,
        default=None,
        help="Path to domainSpecs.jsonl (default: auto-discovered)",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="상세 로깅")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    result = run_country_wiki(
        country=args.country,
        base_path=args.base,
        vault_root=args.vault_root,
        output_dir=args.output,
        wiki_output_dir=args.wiki_output_dir,
        model=args.model,
        spec_path=args.spec_path,
    )

    if result:
        print(f"Country wiki completed: {result}")
    else:
        print("Country wiki generation failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
