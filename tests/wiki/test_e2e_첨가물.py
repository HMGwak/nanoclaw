"""E2E test: 첨가물정보제출 (신규/변경/정기) Wiki Synthesis."""

import importlib
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, "src")
sys.path.insert(0, "src/catalog/methods/karpathy-loop")
sys.path.insert(0, "src/catalog/tasks/wiki")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

from catalog.tasks.wiki.spec_loader import SpecLoader

_task_mod = importlib.import_module("task")
WikiTask = getattr(_task_mod, "WikiTask")

_agents_mod = importlib.import_module("agents")
OpenAIAgents = getattr(_agents_mod, "OpenAIAgents")

_engine_mod = importlib.import_module("engine")
run_loop = getattr(_engine_mod, "run_loop")
build_evaluation_from_spec = getattr(_engine_mod, "build_evaluation_from_spec")

_base_index_mod = importlib.import_module("base_index")
BaseIndexParser = getattr(_base_index_mod, "BaseIndexParser")

VAULT = Path.home() / "Documents" / "Mywork"
BASE_PATH = (
    VAULT / "3. Resource" / "LLM Knowledge Base" / "index" / "첨가물정보 제출.base"
)
WIKI_DIR = VAULT / "3. Resource" / "LLM Knowledge Base" / "wiki"
SPEC_PATH = Path("src/catalog/tasks/wiki/specs/tobacco_regulation.json")
OUTPUT_BASE = Path("/tmp/ql_첨가물")

# Discover all 규제준수 docs
parser = BaseIndexParser(VAULT)
all_docs = parser.discover(BASE_PATH, filter_pattern="(규제준수)_*.md")
print(f"Total 규제준수 docs: {len(all_docs)}")


def classify_by_type(docs: list[Path]) -> dict[str, list[Path]]:
    """Classify docs by 제출유형 from frontmatter."""
    result = {"신규제출": [], "변경제출": [], "정기제출": [], "미분류": []}
    for d in docs:
        try:
            text = d.read_text(encoding="utf-8")
            m = re.search(r"제출유형:\s*(.+)", text)
            if m:
                t = m.group(1).strip().strip('"')
                if "신규" in t:
                    result["신규제출"].append(d)
                elif "변경" in t:
                    result["변경제출"].append(d)
                elif "정기" in t:
                    result["정기제출"].append(d)
                else:
                    result["미분류"].append(d)
            else:
                # Fallback to filename
                if "신규" in d.name:
                    result["신규제출"].append(d)
                elif "변경" in d.name:
                    result["변경제출"].append(d)
                elif "정기" in d.name:
                    result["정기제출"].append(d)
                else:
                    result["미분류"].append(d)
        except Exception:
            result["미분류"].append(d)
    return result


classified = classify_by_type(all_docs)
for k, v in classified.items():
    print(f"  {k}: {len(v)} docs")

# Run each domain
DOMAIN_CONFIG = {
    "신규제출": {"max_docs": 30},
    "변경제출": {"max_docs": 30},
    "정기제출": {"max_docs": 30},
}

spec_loader = SpecLoader(spec_path=SPEC_PATH)
eval_config = spec_loader.load_evaluation("tobacco_regulation", "layer1")
if not eval_config:
    raise ValueError(
        f"Spec at '{SPEC_PATH}' has no layer1.evaluation entry for "
        "domain=tobacco_regulation layer=layer1."
    )
parsed_evaluation = build_evaluation_from_spec(eval_config)

# Select which domain to run (pass as arg, or run all)
domains_to_run = sys.argv[1:] if len(sys.argv) > 1 else list(DOMAIN_CONFIG.keys())

for domain in domains_to_run:
    if domain not in DOMAIN_CONFIG:
        print(f"Unknown domain: {domain}")
        continue

    docs = classified.get(domain, [])
    config = DOMAIN_CONFIG[domain]
    max_docs = config["max_docs"]

    if max_docs and len(docs) > max_docs:
        docs = docs[:max_docs]

    if not docs:
        print(f"\nSkipping {domain}: no docs")
        continue

    print(f"\n{'=' * 60}")
    print(f"Running {domain}: {len(docs)} docs")
    print(f"Spec: {SPEC_PATH}")

    output_dir = OUTPUT_BASE / domain
    reference_files = sorted(WIKI_DIR.glob("*.md"))

    task = WikiTask()
    agents = OpenAIAgents()

    report = run_loop(
        task=task,
        rubric_path=None,
        input_files=docs,  # pre-filtered docs
        reference_files=reference_files,
        agents=agents,
        output_dir=output_dir,
        context_config={
            "domain": domain,
            "base_path": str(BASE_PATH),
            "vault_root": str(VAULT),
            "filter": "(규제준수)_*.md",
            "max_docs": max_docs,
            "prefilled_docs": [str(d) for d in docs],
            "_parsed_evaluation_override": parsed_evaluation,
        },
    )

    print(f"\nStatus: {report.status}")
    print(f"Score: {report.final_score}")
    print(f"Iterations: {len(report.history)}")
    for h in report.history:
        print(f"  iter {h.iteration}: {h.verdict} (score={h.total})")
    print(f"Output: {report.output_files}")
