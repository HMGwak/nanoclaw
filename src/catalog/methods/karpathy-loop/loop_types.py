"""All dataclass and Protocol definitions for quality_loop."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


# ── AgentsProtocol ────────────────────────────────────────────────
class AgentsProtocol(Protocol):
    def generate(self, system_prompt: str, user_prompt: str) -> str: ...
    def evaluate(
        self,
        system_prompt: str,
        content: str,
        rubric_items: list[dict],
    ) -> EvalResult: ...


@dataclass
class EvalResult:
    """agents.evaluate() return type (PRD section 4.2)."""

    scores: dict[str, ItemScore]
    raw_response: str


# ── CancellationToken ─────────────────────────────────────────────
class LoopCancelledError(Exception):
    """Synchronous loop cancellation (replaces asyncio.CancelledError)."""

    pass


@dataclass
class CancellationToken:
    _cancelled: bool = field(default=False, init=False)

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled

    def check(self) -> None:
        if self._cancelled:
            raise LoopCancelledError("Loop cancelled by caller")


# ── Rubric ────────────────────────────────────────────────────────
@dataclass
class RubricConfig:
    keep_threshold: float = 85.0
    discard_threshold: float = 70.0
    max_iterations: int = 3
    convergence_delta: float = 3.0
    task_timeout_seconds: int = 300
    measure_timeout_seconds: int = 10


@dataclass
class RubricItem:
    name: str
    item_type: str  # "quantitative" | "qualitative"
    max_score: float
    description: str
    hard_gate: float | None = None
    anchors: str | None = None
    measure_fn: Callable | None = None


# ── Context ───────────────────────────────────────────────────────
@dataclass
class Context:
    input_files: list[Path]
    reference_files: list[Path]
    output_dir: Path
    agents: AgentsProtocol
    config: dict
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    cancellation: CancellationToken = field(default_factory=CancellationToken)


# ── LoopCallbacks ─────────────────────────────────────────────────
class LoopCallbacks(Protocol):
    def on_iteration_start(self, iteration: int) -> None: ...
    def on_evaluation_complete(
        self, iteration: int, eval_result: EvalOutput
    ) -> None: ...
    def on_verdict(self, iteration: int, verdict: str, score: float) -> None: ...
    def on_loop_complete(self, report: LoopReport) -> None: ...
    def on_error(self, error: Exception) -> None: ...


# ── PRD section 4 types ──────────────────────────────────────────
@dataclass
class FeedbackItem:
    name: str
    score: float
    max_score: float
    rationale: str
    improvements: list[str]


@dataclass
class HardGateFailure:
    name: str
    measured: float
    threshold: float
    message: str


@dataclass
class RunResult:
    output_files: list[Path]
    metadata: dict = field(default_factory=dict)


@dataclass
class Feedback:
    iteration: int
    total_score: float
    items: list[FeedbackItem]
    hard_gate_failures: list[HardGateFailure]
    previous_output_files: list[Path]
    previous_score: float | None = None


# ── PRD section 6 derived types ──────────────────────────────────
@dataclass
class ItemScore:
    score: float
    rationale: str
    improvements: list[str]


@dataclass
class HardGateResult:
    name: str
    threshold: float
    measured: float
    passed: bool


@dataclass
class EvalOutput:
    scores: dict[str, ItemScore]
    hard_gates: list[HardGateResult]
    total: float


@dataclass
class IterationRecord:
    iteration: int
    scores: dict[str, ItemScore]
    total: float
    hard_gate_results: list[HardGateResult]
    verdict: str  # keep/revise/discard/converged/max_iterations/error
    error: str | None = None


@dataclass
class LoopReport:
    status: str  # keep/discard/converged/max_iterations/error
    final_score: float | None
    output_files: list[Path]
    history: list[IterationRecord]
    run_id: str
    error: str | None = None


# ── TaskProtocol ──────────────────────────────────────────────────
class TaskProtocol(Protocol):
    def run(self, context: Context) -> RunResult: ...
    def revise(self, context: Context, feedback: Feedback) -> RunResult: ...
