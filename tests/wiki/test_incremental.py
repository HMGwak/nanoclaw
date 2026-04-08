"""
Test script: incremental (single-pass) wiki synthesis vs map-reduce.
Runs on a small subset (10 docs) and writes output to /tmp/wiki-test/.
"""
import sys
import logging
from pathlib import Path

# Add src/ to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from catalog.tasks.wiki.task import WikiAgent
from catalog.tasks.wiki.synthesizer import ChunkedSynthesizer
from catalog.tasks.wiki.base_index import BaseIndexParser

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

DOMAIN = "첨가물정보제출"
VAULT_ROOT = Path("/Users/planee/Documents/Mywork")
BASE_PATH = VAULT_ROOT / "3. Resource/LLM Knowledge Base/index/첨가물정보 제출.base"
WIKI_OUTPUT_DIR = VAULT_ROOT / "3. Resource/LLM Knowledge Base/wiki"
EXISTING_WIKI = WIKI_OUTPUT_DIR / f"{DOMAIN}.md"
TEST_OUTPUT = Path("/tmp/wiki-test")
MAX_DOCS = None  # all docs


def main():
    TEST_OUTPUT.mkdir(parents=True, exist_ok=True)

    # 1. Discover docs
    parser = BaseIndexParser(VAULT_ROOT)
    all_docs = parser.discover(BASE_PATH)
    docs = all_docs if MAX_DOCS is None else all_docs[:MAX_DOCS]
    logger.info("Using %d/%d docs for test", len(docs), len(all_docs))
    for d in docs:
        logger.info("  - %s", d.name)

    # 2. No existing wiki — create from scratch
    existing_wiki = None
    logger.info("Create mode: no existing wiki")

    # 3. Setup
    agent = WikiAgent()
    logger.info("Agent model: %s", agent.model)

    # Read rubric for doc_structure
    rubric_path = Path(__file__).parent.parent / "methods/karpathy-loop" / "wiki_task.py"
    doc_structure = None  # use default structure

    synthesizer = ChunkedSynthesizer(agent, doc_structure=doc_structure, vault_root=VAULT_ROOT)

    # 4. Run incremental synthesis
    logger.info("=== Starting INCREMENTAL synthesis ===")
    cache_dir = TEST_OUTPUT / "incremental"
    cache_dir.mkdir(parents=True, exist_ok=True)

    wiki_result, succeeded = synthesizer.synthesize_incremental(
        docs=docs,
        existing_wiki=existing_wiki,
        domain=DOMAIN,
        cache_dir=cache_dir,
    )

    # 5. Save result
    out_path = TEST_OUTPUT / f"{DOMAIN}_incremental.md"
    out_path.write_text(wiki_result, encoding="utf-8")
    logger.info("Incremental result: %d chars, %d docs succeeded", len(wiki_result), len(succeeded))
    logger.info("Saved to: %s", out_path)


if __name__ == "__main__":
    main()
