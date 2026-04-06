"""RubricParser + Evaluator + run_loop() + CLI main()."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import pathlib
import re
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from .agents import OpenAIAgents
from .types import (
    AgentsProtocol,
    CancellationToken,
    Context,
    EvalOutput,
    EvalResult,
    Feedback,
    FeedbackItem,
    HardGateFailure,
    HardGateResult,
    ItemScore,
    IterationRecord,
    LoopCallbacks,
    LoopCancelledError,
    LoopReport,
    RubricConfig,
    RubricItem,
    RunResult,
    TaskProtocol,
)

logger = logging.getLogger(__name__)


# ── ParseError ────────────────────────────────────────────────────
class ParseError(Exception):
    """Raised when rubric.md is malformed."""

    pass


# ── RubricParser ──────────────────────────────────────────────────
@dataclass
class ParsedRubric:
    config: RubricConfig
    items: list[RubricItem]
    extra_config: dict


class RubricParser:
    """Parse rubric.md into RubricConfig + list[RubricItem]."""

    EXEC_NAMESPACE = {
        "re": re,
        "pathlib": pathlib,
        "json": json,
        "Path": Path,
    }

    TYPE_MAP = {
        "정량": "quantitative",
        "quantitative": "quantitative",
        "정성": "qualitative",
        "qualitative": "qualitative",
    }

    @classmethod
    def parse(cls, rubric_path: Path) -> ParsedRubric:
        text = rubric_path.read_text(encoding="utf-8")
        config = cls._parse_config(text)
        items = cls._parse_items(text)

        # Validation
        if not items:
            raise ParseError("No rubric items found in rubric.md")

        for item in items:
            if item.item_type not in ("quantitative", "qualitative"):
                raise ParseError(
                    f"Item '{item.name}': invalid type '{item.item_type}'. "
                    "Must be 'quantitative'/'정량' or 'qualitative'/'정성'."
                )

        total_max = sum(it.max_score for it in items)
        has_hard_gate = any(it.hard_gate is not None for it in items)
        if total_max == 0 and not has_hard_gate:
            raise ParseError(
                "All items have max_score=0 and no hard gates defined. "
                "Rubric must have at least one scored item or hard gate."
            )

        extra_config = {}
        return ParsedRubric(config=config, items=items, extra_config=extra_config)

    @classmethod
    def _parse_config(cls, text: str) -> RubricConfig:
        config = RubricConfig()
        # Find the settings section
        m = re.search(r"## 설정\s*\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
        if not m:
            return config

        section = m.group(1)
        field_map = {
            "keep_threshold": float,
            "discard_threshold": float,
            "max_iterations": int,
            "convergence_delta": float,
            "task_timeout_seconds": int,
            "measure_timeout_seconds": int,
        }
        for line in section.strip().splitlines():
            line = line.strip().lstrip("- ")
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if key in field_map:
                setattr(config, key, field_map[key](val))

        return config

    @classmethod
    def _parse_items(cls, text: str) -> list[RubricItem]:
        items: list[RubricItem] = []

        # Split into item sections by ### headings under ## 평가 항목
        eval_section_match = re.search(
            r"## 평가 항목\s*\n(.*)", text, re.DOTALL
        )
        if not eval_section_match:
            return items

        eval_text = eval_section_match.group(1)

        # Split by ### headings
        item_blocks = re.split(r"\n### ", eval_text)
        for block in item_blocks:
            block = block.strip()
            if not block:
                continue

            # Item name is the first line (strip any leftover ### prefix)
            lines = block.split("\n", 1)
            name = lines[0].strip().lstrip("#").strip()
            body = lines[1] if len(lines) > 1 else ""

            # Parse metadata
            item_type_raw = cls._extract_field(body, "타입")
            item_type = cls.TYPE_MAP.get(item_type_raw, item_type_raw)

            max_score_str = cls._extract_field(body, "배점")
            max_score = float(max_score_str) if max_score_str else 0.0

            hard_gate_str = cls._extract_field(body, "하드 게이트")
            hard_gate: float | None = None
            if hard_gate_str and hard_gate_str not in ("없음", "none", "None"):
                # Extract numeric value; may contain text like "있음(0.8)" or just "0.8" or "3"
                gate_match = re.search(r"[\d.]+", hard_gate_str)
                if gate_match:
                    hard_gate = float(gate_match.group())

            description = cls._extract_field(body, "설명") or ""

            # Parse measure function (quantitative)
            measure_fn: Callable | None = None
            if item_type == "quantitative":
                code_match = re.search(
                    r"#### 측정 방법\s*\n```python\s*\n(.*?)```",
                    body,
                    re.DOTALL,
                )
                if code_match:
                    code = code_match.group(1)
                    measure_fn = cls._compile_measure(code, name)

            # Parse anchors (qualitative)
            anchors: str | None = None
            if item_type == "qualitative":
                anchor_match = re.search(
                    r"#### 채점 앵커\s*\n(.*?)(?=\n### |\n## |\Z)",
                    body,
                    re.DOTALL,
                )
                if anchor_match:
                    anchors = anchor_match.group(1).strip()

            items.append(
                RubricItem(
                    name=name,
                    item_type=item_type,
                    max_score=max_score,
                    description=description,
                    hard_gate=hard_gate,
                    anchors=anchors,
                    measure_fn=measure_fn,
                )
            )

        return items

    @classmethod
    def _extract_field(cls, text: str, field_name: str) -> str:
        pattern = rf"- \*\*{field_name}\*\*:\s*(.+)"
        m = re.search(pattern, text)
        return m.group(1).strip() if m else ""

    @classmethod
    def _compile_measure(cls, code: str, item_name: str) -> Callable:
        namespace = dict(cls.EXEC_NAMESPACE)
        try:
            exec(code, namespace)
        except Exception as exc:
            raise ParseError(
                f"Item '{item_name}': failed to compile measure function: {exc}"
            )
        if "measure" not in namespace:
            raise ParseError(
                f"Item '{item_name}': measure() function not defined in code block"
            )
        return namespace["measure"]


# ── Evaluator ─────────────────────────────────────────────────────
class Evaluator:
    """Evaluate output files against rubric items."""

    def __init__(
        self,
        rubric: ParsedRubric,
        agents: AgentsProtocol,
    ):
        self.rubric = rubric
        self.agents = agents

    def evaluate(
        self,
        output_files: list[Path],
        reference_files: list[Path],
    ) -> EvalOutput:
        scores: dict[str, ItemScore] = {}
        hard_gates: list[HardGateResult] = []

        # Quantitative items
        for item in self.rubric.items:
            if item.item_type != "quantitative":
                continue
            measurement = self._run_measure(
                item, output_files, reference_files
            )
            value = measurement["value"]

            # Hard gate check
            if item.hard_gate is not None:
                passed = value >= item.hard_gate
                hard_gates.append(
                    HardGateResult(
                        name=item.name,
                        threshold=item.hard_gate,
                        measured=value,
                        passed=passed,
                    )
                )

            # Score conversion (only if max_score > 0)
            if item.max_score > 0:
                ceiling = item.hard_gate if item.hard_gate else 1.0
                score = min(
                    item.max_score, (value / ceiling) * item.max_score
                )
                scores[item.name] = ItemScore(
                    score=round(score, 1),
                    rationale=measurement["detail"],
                    improvements=[],
                )

        # Qualitative items
        qualitative_dicts = [
            {
                "name": item.name,
                "description": item.description,
                "max_score": item.max_score,
                "anchors": item.anchors,
            }
            for item in self.rubric.items
            if item.item_type == "qualitative"
        ]

        if qualitative_dicts:
            content = ""
            for f in output_files:
                content += f"## {f.name}\n{f.read_text()}\n\n"

            ref_content = ""
            for f in reference_files:
                ref_content += f"## [REF] {f.name}\n{f.read_text()}\n\n"

            system_prompt = (
                "당신은 문서 품질 평가 전문가입니다. "
                "아래 채점 앵커를 엄격하게 적용하여 채점하세요. "
                "경계 점수에서는 낮은 쪽으로 보수적으로 채점하세요. "
                "각 항목에 대해 score, rationale, improvements를 반드시 제공하세요."
            )

            eval_content = f"{content}\n---\n참조 소스:\n{ref_content}"
            llm_result = self.agents.evaluate(
                system_prompt, eval_content, qualitative_dicts
            )

            # Clamp scores to max_score
            max_score_map = {
                item.name: item.max_score
                for item in self.rubric.items
                if item.item_type == "qualitative"
            }
            for name, item_score in llm_result.scores.items():
                if name in max_score_map:
                    item_score.score = min(max_score_map[name], item_score.score)
                scores[name] = item_score

        total = sum(s.score for s in scores.values())
        return EvalOutput(
            scores=scores, hard_gates=hard_gates, total=round(total, 1)
        )

    def _run_measure(
        self,
        item: RubricItem,
        output_files: list[Path],
        reference_files: list[Path],
    ) -> dict:
        """Run quantitative measure with timeout."""
        if item.measure_fn is None:
            return {"value": 0.0, "detail": "No measure function defined"}

        timeout = self.rubric.config.measure_timeout_seconds
        result_container: list[dict] = []
        error_container: list[Exception] = []

        def _run():
            try:
                r = item.measure_fn(output_files, reference_files)
                result_container.append(r)
            except Exception as exc:
                error_container.append(exc)

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            logger.error(
                "measure() for '%s' timed out after %ds", item.name, timeout
            )
            return {"value": 0.0, "detail": f"Timeout after {timeout}s"}

        if error_container:
            logger.error(
                "measure() for '%s' raised: %s", item.name, error_container[0]
            )
            return {"value": 0.0, "detail": str(error_container[0])}

        if not result_container:
            return {"value": 0.0, "detail": "No result returned"}

        return result_container[0]


# ── build_feedback ────────────────────────────────────────────────
def _build_feedback(
    iteration: int,
    eval_result: EvalOutput,
    rubric: ParsedRubric,
    gate_failures: list[HardGateResult],
    previous_output_files: list[Path],
) -> Feedback:
    items: list[FeedbackItem] = []
    item_map = {it.name: it for it in rubric.items}

    for name, score_info in eval_result.scores.items():
        it = item_map.get(name)
        ms = it.max_score if it else 0.0
        items.append(
            FeedbackItem(
                name=name,
                score=score_info.score,
                max_score=ms,
                rationale=score_info.rationale,
                improvements=score_info.improvements,
            )
        )

    # Sort by relative score ascending (worst first)
    items.sort(key=lambda x: x.score / x.max_score if x.max_score > 0 else 0)

    hard_gate_failures = [
        HardGateFailure(
            name=g.name,
            measured=g.measured,
            threshold=g.threshold,
            message=f"{g.name}: {g.measured} < {g.threshold}",
        )
        for g in gate_failures
    ]

    return Feedback(
        iteration=iteration,
        total_score=eval_result.total,
        items=items,
        hard_gate_failures=hard_gate_failures,
        previous_output_files=previous_output_files,
    )


# ── run_loop ──────────────────────────────────────────────────────
def run_loop(
    task: TaskProtocol,
    rubric_path: Path,
    input_files: list[Path],
    reference_files: list[Path],
    agents: AgentsProtocol,
    output_dir: Path,
    callbacks: LoopCallbacks | None = None,
) -> LoopReport:
    """Main quality loop entry point."""
    run_id = str(uuid.uuid4())
    cancellation = CancellationToken()

    rubric = RubricParser.parse(rubric_path)
    evaluator = Evaluator(rubric, agents)

    context = Context(
        input_files=input_files,
        reference_files=reference_files,
        output_dir=output_dir,
        agents=agents,
        config=rubric.extra_config,
        run_id=run_id,
        cancellation=cancellation,
    )

    history: list[IterationRecord] = []
    prev_score = 0.0
    result: RunResult | None = None
    last_good_files: list[Path] = []

    output_dir.mkdir(parents=True, exist_ok=True)

    config = rubric.config

    for iteration in range(1, config.max_iterations + 1):
        # Cancellation check
        try:
            cancellation.check()
        except LoopCancelledError:
            return LoopReport(
                status="error",
                final_score=history[-1].total if history else None,
                output_files=last_good_files,
                history=history,
                run_id=run_id,
                error="Loop cancelled by caller",
            )

        logger.info("PROGRESS iteration=%d started", iteration)

        if callbacks is not None:
            try:
                callbacks.on_iteration_start(iteration)
            except Exception:
                pass

        # Create iter_N/ subdirectory
        iter_dir = output_dir / f"iter_{iteration}"
        iter_dir.mkdir(parents=True, exist_ok=True)
        context.output_dir = iter_dir

        # Run or revise
        try:
            if iteration == 1:
                result = task.run(context)
            else:
                feedback = _build_feedback(
                    iteration=iteration - 1,
                    eval_result=eval_output,
                    rubric=rubric,
                    gate_failures=gate_failures,
                    previous_output_files=last_good_files,
                )
                result = task.revise(context, feedback)
        except Exception as exc:
            logger.error("Task execution error at iteration %d: %s", iteration, exc)
            error_record = IterationRecord(
                iteration=iteration,
                scores={},
                total=0.0,
                hard_gate_results=[],
                verdict="error",
                error=str(exc),
            )
            history.append(error_record)
            if callbacks is not None:
                try:
                    callbacks.on_error(exc)
                except Exception:
                    pass
            break

        # Empty output check
        if not result.output_files:
            error_record = IterationRecord(
                iteration=iteration,
                scores={},
                total=0.0,
                hard_gate_results=[],
                verdict="error",
                error="Task produced no output files",
            )
            history.append(error_record)
            break

        last_good_files = result.output_files

        # Evaluate
        eval_output = evaluator.evaluate(result.output_files, reference_files)

        if callbacks is not None:
            try:
                callbacks.on_evaluation_complete(iteration, eval_output)
            except Exception:
                pass

        # Build iteration record
        record = IterationRecord(
            iteration=iteration,
            scores=eval_output.scores,
            total=eval_output.total,
            hard_gate_results=eval_output.hard_gates,
            verdict="",  # determined below
        )

        # Hard gate check
        gate_failures = [g for g in eval_output.hard_gates if not g.passed]

        # Verdict logic
        if not gate_failures and eval_output.total >= config.keep_threshold:
            record.verdict = "keep"
            history.append(record)
            _notify_verdict(callbacks, iteration, "keep", eval_output.total)
            break

        if eval_output.total < config.discard_threshold and iteration > 1:
            record.verdict = "discard"
            history.append(record)
            _notify_verdict(callbacks, iteration, "discard", eval_output.total)
            break

        # Convergence check (from iteration 2+)
        # Bug fix: only consider convergence when delta >= 0
        if iteration > 1:
            delta = eval_output.total - prev_score
            if 0 <= delta < config.convergence_delta:
                record.verdict = "converged"
                history.append(record)
                _notify_verdict(
                    callbacks, iteration, "converged", eval_output.total
                )
                break

        # Max iterations check
        if iteration == config.max_iterations:
            record.verdict = "max_iterations"
            history.append(record)
            _notify_verdict(
                callbacks, iteration, "max_iterations", eval_output.total
            )
            break

        # Continue with revise
        record.verdict = "revise"
        history.append(record)
        _notify_verdict(callbacks, iteration, "revise", eval_output.total)
        logger.info(
            "PROGRESS iteration=%d verdict=%s score=%.1f",
            iteration, record.verdict, eval_output.total,
        )
        # Incremental report write (crash resilience)
        _write_incremental_report(output_dir, history, run_id)
        prev_score = eval_output.total

    # Finalize output
    final = history[-1] if history else None
    status = final.verdict if final else "error"
    final_score = final.total if final else None

    # Copy final output
    final_dir = output_dir / "final"
    discarded_dir = output_dir / ".discarded"

    if status == "keep" or status == "converged" or status == "max_iterations":
        final_dir.mkdir(parents=True, exist_ok=True)
        for f in last_good_files:
            if f.exists():
                shutil.copy2(f, final_dir / f.name)
    elif status == "discard":
        discarded_dir.mkdir(parents=True, exist_ok=True)
        for f in last_good_files:
            if f.exists():
                shutil.copy2(f, discarded_dir / f.name)

    report = LoopReport(
        status=status,
        final_score=final_score,
        output_files=(
            list(final_dir.iterdir())
            if status in ("keep", "converged", "max_iterations") and final_dir.exists()
            else []
        ),
        history=history,
        run_id=run_id,
        error=final.error if final else None,
    )

    logger.info(
        "PROGRESS complete status=%s score=%s",
        report.status, report.final_score,
    )

    # Write report.json
    _write_report(output_dir / "report.json", report)

    if callbacks is not None:
        try:
            callbacks.on_loop_complete(report)
        except Exception:
            pass

    # Restore output_dir on context
    context.output_dir = output_dir

    return report


def _notify_verdict(
    callbacks: LoopCallbacks | None,
    iteration: int,
    verdict: str,
    score: float,
) -> None:
    if callbacks is not None:
        try:
            callbacks.on_verdict(iteration, verdict, score)
        except Exception:
            pass


def _write_report(path: Path, report: LoopReport) -> None:
    """Serialize LoopReport to JSON."""

    def _serialize(obj):
        if isinstance(obj, Path):
            return str(obj)
        if hasattr(obj, "__dataclass_fields__"):
            return {k: _serialize(v) for k, v in asdict(obj).items()}
        if isinstance(obj, list):
            return [_serialize(v) for v in obj]
        if isinstance(obj, dict):
            return {k: _serialize(v) for k, v in obj.items()}
        return obj

    data = _serialize(report)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def _write_incremental_report(
    output_dir: Path,
    history: list[IterationRecord],
    run_id: str,
) -> None:
    """Write partial report after each iteration for crash resilience."""
    partial = LoopReport(
        status="in_progress",
        final_score=history[-1].total if history else None,
        output_files=[],
        history=history,
        run_id=run_id,
    )
    try:
        _write_report(output_dir / "report.json", partial)
    except Exception:
        logger.warning("Failed to write incremental report")


# ── CLI ───────────────────────────────────────────────────────────
def main():
    """CLI entry point: quality-loop command."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Quality Loop Engine - evaluate, revise, repeat"
    )
    parser.add_argument(
        "--task",
        required=True,
        help="Task class in 'module.ClassName' format (e.g. wiki_task.WikiTask)",
    )
    parser.add_argument(
        "--rubric",
        required=True,
        type=Path,
        help="Path to rubric.md",
    )
    parser.add_argument(
        "--input",
        required=True,
        nargs="+",
        help="Input file glob patterns",
    )
    parser.add_argument(
        "--reference",
        nargs="+",
        default=[],
        help="Reference file glob patterns",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Output directory",
    )
    parser.add_argument(
        "--model",
        default="claude-sonnet-4-6",
        help="LLM model to use (default: claude-sonnet-4-6)",
    )

    args = parser.parse_args()

    # Load task class
    task = _load_task(args.task)

    # Resolve input/reference globs
    input_files = _resolve_globs(args.input)
    reference_files = _resolve_globs(args.reference)

    if not input_files:
        logger.error("No input files found matching: %s", args.input)
        raise SystemExit(1)

    logger.info("Input files: %d", len(input_files))
    logger.info("Reference files: %d", len(reference_files))

    agents = OpenAIAgents(model=args.model)

    report = run_loop(
        task=task,
        rubric_path=args.rubric,
        input_files=input_files,
        reference_files=reference_files,
        agents=agents,
        output_dir=args.output,
    )

    logger.info("Loop completed: status=%s, score=%s", report.status, report.final_score)
    logger.info("Report written to: %s", args.output / "report.json")


def _load_task(task_spec: str) -> TaskProtocol:
    """Load a task class from 'module.ClassName' string."""
    if "." not in task_spec:
        raise ValueError(
            f"Invalid task spec '{task_spec}': must be 'module.ClassName'"
        )
    module_path, _, class_name = task_spec.rpartition(".")
    module = importlib.import_module(module_path)
    cls = getattr(module, class_name)
    return cls()


def _resolve_globs(patterns: list[str]) -> list[Path]:
    """Resolve glob patterns to file paths."""
    files: list[Path] = []
    for pattern in patterns:
        expanded = Path(pattern).expanduser()
        if expanded.exists() and expanded.is_file():
            files.append(expanded)
        else:
            parent = expanded.parent
            glob_pattern = expanded.name
            if parent.exists():
                files.extend(sorted(parent.glob(glob_pattern)))
    return files


if __name__ == "__main__":
    main()
