"""
Test: Run the karpathy quality loop on an existing wiki for evaluate/revise.
Takes the incremental wiki and polishes it through rubric-based iteration.
"""

import sys
import shutil
import logging
from pathlib import Path

import importlib.util

_src = Path(__file__).resolve().parent.parent.parent.parent
_kl = _src / "catalog" / "methods" / "karpathy-loop"
sys.path.insert(0, str(_src))
sys.path.insert(0, str(_kl))


def _load(name, fpath):
    spec = importlib.util.spec_from_file_location(name, fpath)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module {name} from {fpath}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_loop_types = _load("loop_types", _kl / "loop_types.py")
_engine = _load("engine", _kl / "engine.py")
_agents = _load("agents", _kl / "agents.py")

run_loop = _engine.run_loop
LoopCallbacks = _engine.LoopCallbacks
RunResult = _loop_types.RunResult
Context = _loop_types.Context
OpenAIAgents = _agents.OpenAIAgents

from catalog.tasks.wiki.synthesizer import (
    strip_code_blocks,
    filter_attachment_footnotes,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

DOMAIN = "첨가물정보제출"
INPUT_WIKI = Path("/tmp/wiki-test/첨가물정보제출_incremental.md")
RUBRIC_FILE = _kl / "test_rubric.md"
OUTPUT_DIR = Path("/tmp/wiki-test/quality-loop")


class PrebuiltWikiTask:
    """Wrapper task that returns a pre-built wiki on run(), and does real revision."""

    def __init__(self, wiki_content: str):
        from catalog.tasks.wiki.task import WikiAgent

        self.wiki_content = wiki_content
        self.agent = WikiAgent()

    def run(self, context: Context) -> RunResult:
        """Return the pre-built wiki as-is for first evaluation."""
        context.output_dir.mkdir(parents=True, exist_ok=True)
        domain = context.config.get("domain", DOMAIN)
        out_path = context.output_dir / f"{domain}.md"
        out_path.write_text(self.wiki_content, encoding="utf-8")
        logger.info("PrebuiltWikiTask.run(): loaded %d chars", len(self.wiki_content))
        return RunResult(
            output_files=[out_path],
            metadata={"domain": domain, "prebuilt": True},
        )

    def revise(self, context: Context, feedback) -> RunResult:
        """Real revision using WikiAgent based on feedback."""
        domain = context.config.get("domain", DOMAIN)
        prev_path = context.output_dir / f"{domain}.md"

        # Read previous output
        if prev_path.exists():
            prev_wiki = prev_path.read_text(encoding="utf-8")
        else:
            prev_wiki = self.wiki_content

        # Build feedback text from structured Feedback object
        feedback_lines = [f"총점: {feedback.total_score}"]
        for item in feedback.items:
            feedback_lines.append(
                f"- [{item.name}] 점수: {item.score}/{item.max_score}"
            )
            feedback_lines.append(f"  근거: {item.rationale}")
            for imp in item.improvements:
                feedback_lines.append(f"  개선: {imp}")
        for gate in feedback.hard_gate_failures:
            feedback_lines.append(f"- [HARD GATE FAIL] {gate.name}: {gate.message}")
        feedback_text = "\n".join(feedback_lines)

        # Build revision prompt
        revision_prompt = (
            f"아래는 현재 wiki note입니다. 리뷰어의 피드백을 반영하여 개선하세요.\n\n"
            f"## 피드백\n{feedback_text}\n\n"
            f"## 현재 wiki\n{prev_wiki}"
        )

        revised = self.agent.generate(
            system_prompt=(
                "You are an expert wiki editor. Revise the wiki note based on the reviewer feedback.\n"
                "Rules:\n"
                "- Fix all issues mentioned in the feedback.\n"
                "- Preserve all footnote citations [^N]: [[(filename)]].\n"
                "- Keep the same heading structure.\n"
                "- Write ALL content in Korean.\n"
                "- Output the COMPLETE revised wiki note."
            ),
            user_prompt=revision_prompt,
        )

        revised = strip_code_blocks(revised)
        revised = filter_attachment_footnotes(revised)

        context.output_dir.mkdir(parents=True, exist_ok=True)
        out_path = context.output_dir / f"{domain}.md"
        out_path.write_text(revised, encoding="utf-8")
        logger.info(
            "PrebuiltWikiTask.revise(): %d chars → %d chars",
            len(prev_wiki),
            len(revised),
        )

        return RunResult(
            output_files=[out_path],
            metadata={"domain": domain, "revised": True},
        )


def main():
    if not INPUT_WIKI.exists():
        logger.error("Input wiki not found: %s", INPUT_WIKI)
        sys.exit(1)

    if not RUBRIC_FILE.exists():
        logger.error("Rubric not found: %s", RUBRIC_FILE)
        sys.exit(1)

    wiki_content = INPUT_WIKI.read_text(encoding="utf-8")
    logger.info("Input wiki: %d chars", len(wiki_content))
    logger.info("Rubric: %s", RUBRIC_FILE)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    task = PrebuiltWikiTask(wiki_content)
    agents = OpenAIAgents()

    report = run_loop(
        task=task,
        rubric_path=RUBRIC_FILE,
        input_files=[],
        reference_files=[],
        agents=agents,
        output_dir=OUTPUT_DIR,
        context_config={"domain": DOMAIN},
    )

    logger.info(
        "Quality loop done: status=%s, score=%s, iterations=%d",
        report.status,
        report.final_score,
        len(report.history),
    )

    # Copy final to OneDrive
    final_dir = OUTPUT_DIR / "final"
    if final_dir.exists():
        for f in final_dir.iterdir():
            dest = Path(f"/Users/planee/OneDrive - ktng.com/{f.name}")
            shutil.copy2(f, dest)
            logger.info("Copied to OneDrive: %s", dest)


if __name__ == "__main__":
    main()
