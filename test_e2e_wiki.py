"""E2E test: WikiTask + Quality Loop + ChatGPT OAuth with real vault data."""

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
INPUT_DIR = VAULT / "4. Archive" / "inbox"
WIKI_DIR = VAULT / "3. Resource" / "LLM Knowledge Base" / "wiki"
RUBRIC = Path("src/catalog/tasks/wiki/rubric_wiki.md")
OUTPUT = Path("/tmp/ql_wiki_e2e")

# Input: (안전성검토)_*.md only (not 사전안전성검토), limit to 2
input_files = sorted([
    f for f in INPUT_DIR.glob("(안전성검토)_*.md")
    if not f.name.startswith("(사전안전성검토)")
])[:2]

# Reference: existing wiki notes
reference_files = sorted(WIKI_DIR.glob("*.md"))

print(f"Input files ({len(input_files)}):")
for f in input_files:
    print(f"  {f.name}")
print(f"Reference files ({len(reference_files)}):")
for f in reference_files:
    print(f"  {f.name}")
print(f"Rubric: {RUBRIC}")
print(f"Output: {OUTPUT}")
print()

task = WikiTask()
agents = OpenAIAgents()

report = run_loop(
    task=task,
    rubric_path=RUBRIC,
    input_files=input_files,
    reference_files=reference_files,
    agents=agents,
    output_dir=OUTPUT,
)

print(f"\n{'='*60}")
print(f"Status: {report.status}")
print(f"Score: {report.final_score}")
print(f"Iterations: {len(report.history)}")
for h in report.history:
    print(f"  iter {h.iteration}: {h.verdict} (score={h.total})")
print(f"Output files: {report.output_files}")
print(f"Report: {OUTPUT / 'report.json'}")
