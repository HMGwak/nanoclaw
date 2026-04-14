"""E2E test: WikiTask N:1 synthesis + Quality Loop + ChatGPT OAuth."""

import logging
import importlib
import sys
from pathlib import Path

# Fix import paths for direct script execution
sys.path.insert(0, "src")
sys.path.insert(0, "src/catalog/methods/karpathy-loop")
sys.path.insert(0, "src/catalog/tasks/wiki")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

from catalog.tasks.wiki.spec_loader import SpecLoader  # noqa: E402

_task_mod = importlib.import_module("task")
WikiTask = getattr(_task_mod, "WikiTask")

_agents_mod = importlib.import_module("agents")
OpenAIAgents = getattr(_agents_mod, "OpenAIAgents")

_engine_mod = importlib.import_module("engine")
run_loop = getattr(_engine_mod, "run_loop")
build_evaluation_from_spec = getattr(_engine_mod, "build_evaluation_from_spec")

VAULT = Path.home() / "Documents" / "Mywork"
BASE_PATH = VAULT / "3. Resource" / "LLM Knowledge Base" / "index" / "안전성검토.base"
WIKI_DIR = VAULT / "3. Resource" / "LLM Knowledge Base" / "wiki"
SPEC_PATH = Path("src/catalog/tasks/wiki/specs/tobacco_regulation.json")
OUTPUT = Path("/tmp/ql_wiki_synthesis")

# Reference: existing wiki notes
reference_files = sorted(WIKI_DIR.glob("*.md"))

print(f"Base index: {BASE_PATH}")
print(f"Filter: (안전성검토)_*.md")
print(f"Reference files ({len(reference_files)}):")
for f in reference_files:
    print(f"  {f.name}")
print(f"Spec: {SPEC_PATH}")
print(f"Output: {OUTPUT}")
print()

task = WikiTask()
agents = OpenAIAgents()

spec_loader = SpecLoader(spec_path=SPEC_PATH)
eval_config = spec_loader.load_evaluation("tobacco_regulation", "layer1")
if not eval_config:
    raise ValueError(
        f"Spec at '{SPEC_PATH}' has no layer1.evaluation entry for "
        "domain=tobacco_regulation layer=layer1."
    )
parsed_evaluation = build_evaluation_from_spec(eval_config)

# N:1 synthesis mode via context.config
report = run_loop(
    task=task,
    rubric_path=None,
    input_files=[],  # discovery handled by base_index
    reference_files=reference_files,
    agents=agents,
    output_dir=OUTPUT,
    context_config={
        "domain": "안전성검토",
        "base_path": str(BASE_PATH),
        "vault_root": str(VAULT),
        "filter": "(안전성검토)_*.md",
        "wiki_output_dir": str(WIKI_DIR),
        "max_docs": 150,  # 5 batches × 30 docs (gpt-5.4)
        "_parsed_evaluation_override": parsed_evaluation,
    },
)

print(f"\n{'=' * 60}")
print(f"Status: {report.status}")
print(f"Score: {report.final_score}")
print(f"Iterations: {len(report.history)}")
for h in report.history:
    print(f"  iter {h.iteration}: {h.verdict} (score={h.total})")
print(f"Output files: {report.output_files}")
print(f"Report: {OUTPUT / 'report.json'}")
