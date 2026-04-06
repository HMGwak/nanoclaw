"""E2E test: WikiTask N:1 synthesis + Quality Loop + ChatGPT OAuth."""

import logging
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

from task import WikiTask  # noqa: E402
from agents import OpenAIAgents  # noqa: E402
from engine import run_loop  # noqa: E402

VAULT = Path.home() / "Documents" / "Mywork"
BASE_PATH = VAULT / "3. Resource" / "LLM Knowledge Base" / "index" / "안전성검토.base"
WIKI_DIR = VAULT / "3. Resource" / "LLM Knowledge Base" / "wiki"
RUBRIC = Path("src/catalog/tasks/wiki/rubrics/rubric_안전성검토.md")
OUTPUT = Path("/tmp/ql_wiki_synthesis")

# Reference: existing wiki notes
reference_files = sorted(WIKI_DIR.glob("*.md"))

print(f"Base index: {BASE_PATH}")
print(f"Filter: (안전성검토)_*.md")
print(f"Reference files ({len(reference_files)}):")
for f in reference_files:
    print(f"  {f.name}")
print(f"Rubric: {RUBRIC}")
print(f"Output: {OUTPUT}")
print()

task = WikiTask()
agents = OpenAIAgents()

# N:1 synthesis mode via context.config
report = run_loop(
    task=task,
    rubric_path=RUBRIC,
    input_files=[],  # discovery handled by base_index
    reference_files=reference_files,
    agents=agents,
    output_dir=OUTPUT,
    context_config={
        "domain": "안전성검토",
        "base_path": str(BASE_PATH),
        "vault_root": str(VAULT),
        "filter": "(안전성검토)_*.md",
        "max_docs": 150,  # 5 batches × 30 docs (gpt-5.4)
    },
)

print(f"\n{'='*60}")
print(f"Status: {report.status}")
print(f"Score: {report.final_score}")
print(f"Iterations: {len(report.history)}")
for h in report.history:
    print(f"  iter {h.iteration}: {h.verdict} (score={h.total})")
print(f"Output files: {report.output_files}")
print(f"Report: {OUTPUT / 'report.json'}")
