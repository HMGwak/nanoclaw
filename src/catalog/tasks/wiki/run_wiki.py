from __future__ import annotations

import argparse
import importlib
import logging
import re
import shutil
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
KARPATHY_DIR = ROOT / "src" / "catalog" / "methods" / "karpathy-loop"

for candidate in (str(KARPATHY_DIR), str(ROOT / "src")):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

_engine_mod = importlib.import_module("engine")
run_loop = getattr(_engine_mod, "run_loop")
build_evaluation_from_spec = getattr(_engine_mod, "build_evaluation_from_spec")

_agents_mod = importlib.import_module("agents")
OpenAIAgents = getattr(_agents_mod, "OpenAIAgents")

from catalog.tasks.wiki.base_index import BaseIndexParser
from catalog.tasks.wiki.spec_loader import SpecLoader
from catalog.tasks.wiki.task import WikiTask

logger = logging.getLogger(__name__)

DEFAULT_SPEC_DIR = Path(__file__).resolve().parent / "specs"
DEFAULT_VAULT_ROOT = Path.home() / "Documents" / "Mywork"
DEFAULT_INDEX_ROOT = Path("3. Resource/LLM Knowledge Base/index")
DEFAULT_WIKI_ROOT = Path("3. Resource/LLM Knowledge Base/wiki")
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


def resolve_base_path(domain: str, vault_root: Path) -> Path:
    suffix = domain if domain.endswith(".base") else f"{domain}.base"
    return (vault_root / DEFAULT_INDEX_ROOT / suffix).resolve()


def resolve_wiki_output_dir(vault_root: Path, wiki_output_dir: str) -> Path:
    target = Path(wiki_output_dir)
    if target.is_absolute():
        return target
    return (vault_root / DEFAULT_WIKI_ROOT / target).resolve()


def default_run_root(vault_root: Path, domain: str) -> Path:
    return vault_root / ".nanoclaw" / "wiki-runs" / domain / uuid.uuid4().hex[:8]


def copy_final_output(
    final_file: Path | None, destination_dir: Path, domain: str
) -> Path | None:
    if not final_file or not final_file.exists():
        return None
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{domain}.md"
    shutil.copy2(final_file, destination)
    return destination


def load_domain_assets(spec_path: Path, domain: str) -> dict:
    loader = SpecLoader(spec_path=spec_path)
    structure = loader.load_structure(domain)
    headings: list[str] | None = (
        _tree_to_headings({"structure": structure}) if structure else None
    )
    ordered_layers = loader.load_layers(domain)
    return {
        "doc_structure": headings,
        "layers": ordered_layers,
        "shared_prompt_rules": loader.load_shared_prompt_rules(domain),
    }


def build_layer_context(
    *,
    domain: str,
    layer: str,
    vault_root: Path,
    wiki_output_dir: Path,
    spec_path: Path,
    filter_expr: str | None,
    max_docs: int | None,
    domain_assets: dict,
) -> dict:
    loader = SpecLoader(spec_path=spec_path)
    base_path = resolve_base_path(domain, vault_root)
    source_config = loader.load_source(domain, layer)
    view = (source_config or {}).get("view")
    eval_config = loader.load_evaluation(domain, layer)
    if not eval_config:
        raise ValueError(
            f"Spec at '{spec_path}' has no {layer}.evaluation entry for domain={domain}."
        )

    parsed_evaluation = build_evaluation_from_spec(eval_config)
    parsed_evaluation.extra_config["doc_structure"] = domain_assets.get("doc_structure")

    context_config: dict = {
        "domain": domain,
        "base_path": str(base_path),
        "vault_root": str(vault_root),
        "wiki_output_dir": str(wiki_output_dir),
        "view": view,
        "filter": filter_expr,
        "_parsed_evaluation_override": parsed_evaluation,
    }
    if max_docs is not None:
        context_config["max_docs"] = max_docs
    if domain_assets.get("doc_structure"):
        context_config["doc_structure"] = domain_assets["doc_structure"]

    shared_rules = domain_assets.get("shared_prompt_rules") or {}

    prompt_extract = loader.load_extract_prompt(domain, layer)
    if prompt_extract:
        shared_extract = shared_rules.get("extract")
        context_config["spec_extract_prompt"] = (
            f"{shared_extract}\n\n{prompt_extract}"
            if shared_extract
            else prompt_extract
        )
    prompt_compose = loader.load_compose_prompt(domain, layer)
    if prompt_compose:
        shared_compose = shared_rules.get("compose")
        context_config["spec_compose_prompt"] = (
            f"{shared_compose}\n\n{prompt_compose}"
            if shared_compose
            else prompt_compose
        )
    prompt_update = loader.load_update_prompt(domain, layer)
    if prompt_update:
        shared_compose = shared_rules.get("compose")
        context_config["spec_update_prompt"] = (
            f"{shared_compose}\n\n{prompt_update}" if shared_compose else prompt_update
        )
    prompt_revise = loader.load_revise_prompt(domain, layer)
    if prompt_revise:
        shared_compose = shared_rules.get("compose")
        context_config["spec_revise_prompt"] = (
            f"{shared_compose}\n\n{prompt_revise}" if shared_compose else prompt_revise
        )

    return context_config


def dry_run_domain(
    *,
    domain: str,
    vault_root: Path,
    spec_path: Path,
    filter_expr: str | None,
) -> list[tuple[str, str | None, list[Path]]]:
    domain_assets = load_domain_assets(spec_path, domain)
    parser = BaseIndexParser(vault_root)
    base_path = resolve_base_path(domain, vault_root)
    results: list[tuple[str, str | None, list[Path]]] = []
    for layer in domain_assets["layers"]:
        loader = SpecLoader(spec_path=spec_path)
        source_entry = loader.load_source(domain, layer) or {}
        view = source_entry.get("view")
        docs = parser.discover(base_path, view_name=view, filter_expr=filter_expr)
        results.append((layer, view, docs))
    return results


def run_wiki(
    *,
    domain: str,
    wiki_output_dir: str,
    filter_expr: str | None,
    vault_root: Path,
    spec_path: Path,
    model: str | None,
    max_docs: int | None,
    output_dir: Path | None,
) -> Path | None:
    domain_assets = load_domain_assets(spec_path, domain)
    run_root = output_dir or default_run_root(vault_root, domain)
    run_root.mkdir(parents=True, exist_ok=True)
    resolved_output_dir = resolve_wiki_output_dir(vault_root, wiki_output_dir)
    agents = OpenAIAgents(model=model) if model else OpenAIAgents()

    previous_wiki_path: Path | None = None
    for layer in domain_assets["layers"]:
        layer_dir = run_root / layer
        layer_dir.mkdir(parents=True, exist_ok=True)
        context_config = build_layer_context(
            domain=domain,
            layer=layer,
            vault_root=vault_root,
            wiki_output_dir=resolved_output_dir,
            spec_path=spec_path,
            filter_expr=filter_expr,
            max_docs=max_docs,
            domain_assets=domain_assets,
        )
        if not context_config.get("view"):
            raise ValueError(
                f"No layer source view configured for domain={domain} layer={layer}."
            )
        reference_files = (
            [previous_wiki_path]
            if previous_wiki_path and previous_wiki_path.exists()
            else []
        )
        report = run_loop(
            WikiTask(),
            None,
            input_files=[],
            reference_files=reference_files,
            agents=agents,
            output_dir=layer_dir,
            context_config=context_config,
        )
        if report.output_files:
            previous_wiki_path = report.output_files[0]
        else:
            final_dir = layer_dir / "final"
            if final_dir.exists():
                finals = sorted(p for p in final_dir.iterdir() if p.is_file())
                if finals:
                    previous_wiki_path = finals[0]

    copied = copy_final_output(previous_wiki_path, resolved_output_dir, domain)
    if copied:
        logger.info("Final wiki copied to %s", copied)
    return copied or previous_wiki_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run wiki generation from one domain spec.",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "domain = index filename = spec domain key\n"
            "layers are discovered from the spec; full runner does not accept --layer or --view\n"
            "filter grammar:\n"
            '  (field1="value1")+(field2="value2")\n'
            '  (field1="value1")|(field1="value2")\n'
            '  ((field1="value1")+(field2="value2"))|(field3="value3")\n'
            "filter is applied as an AND restriction on top of each layer source result set\n"
            "use --dry-run to preview per-layer source selection and document counts without LLM calls"
        ),
    )
    parser.add_argument(
        "--domain",
        required=True,
        help="Spec domain key and index filename without .base",
    )
    parser.add_argument(
        "--wiki-output-dir",
        required=True,
        help="Vault-relative wiki output subdirectory under 3. Resource/LLM Knowledge Base/wiki",
    )
    parser.add_argument(
        "--filter",
        default=None,
        help='Optional frontmatter filter expression using + for AND, | for OR, parentheses, and field="value" equality.',
    )
    parser.add_argument(
        "--spec-path",
        type=Path,
        default=None,
        help="Optional spec JSON path. If omitted, uses src/catalog/tasks/wiki/specs/{domain}.json",
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        default=DEFAULT_VAULT_ROOT,
        help="Obsidian vault root (default: ~/Documents/Mywork)",
    )
    parser.add_argument("--model", default=None, help="LLM model override")
    parser.add_argument(
        "--max-docs",
        type=int,
        default=None,
        help="Limit number of discovered docs for smoke runs",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional explicit work directory. If omitted, a managed .nanoclaw/wiki-runs path is used.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview layers, views, and filtered document counts without running the model loop",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    vault_root = args.vault_root.expanduser().resolve()
    spec_path = args.spec_path or (DEFAULT_SPEC_DIR / f"{args.domain}.json")
    if args.dry_run:
        results = dry_run_domain(
            domain=args.domain,
            vault_root=vault_root,
            spec_path=spec_path,
            filter_expr=args.filter,
        )
        for layer, view, docs in results:
            print(f"[{layer}] view={view} docs={len(docs)}")
            for doc in docs[:5]:
                print(f" - {doc}")
        return

    result = run_wiki(
        domain=args.domain,
        wiki_output_dir=args.wiki_output_dir,
        filter_expr=args.filter,
        vault_root=vault_root,
        spec_path=spec_path,
        model=args.model,
        max_docs=args.max_docs,
        output_dir=args.output,
    )
    if result and result.exists():
        print(f"Wiki generation completed: {result}")
        return
    print("Wiki generation failed")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
