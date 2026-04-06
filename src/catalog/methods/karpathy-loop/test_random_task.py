"""Random value task for testing quality loop mechanics."""

from __future__ import annotations

import random
from pathlib import Path

try:
    from .loop_types import Context, Feedback, RunResult
except ImportError:
    from loop_types import Context, Feedback, RunResult  # type: ignore[no-redef]


class RandomTask:
    """Writes a random float (0.0–1.0) to output. No LLM needed."""

    def run(self, context: Context) -> RunResult:
        value = random.random()
        out = context.output_dir / "result.txt"
        out.write_text(f"{value:.4f}")
        return RunResult(output_files=[out])

    def revise(self, context: Context, feedback: Feedback) -> RunResult:
        # Each revise is just another random roll
        value = random.random()
        out = context.output_dir / "result.txt"
        out.write_text(f"{value:.4f}")
        return RunResult(output_files=[out])
