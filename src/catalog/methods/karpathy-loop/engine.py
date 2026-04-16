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

try:
    from .agents import OpenAIAgents
    from .loop_types import (
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
except ImportError:
    from agents import OpenAIAgents  # type: ignore[no-redef]
    from loop_types import (  # type: ignore[no-redef]
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
        doc_structure = cls._parse_doc_structure(text)
        if doc_structure:
            extra_config["doc_structure"] = doc_structure
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
        eval_section_match = re.search(r"## 평가 항목\s*\n(.*)", text, re.DOTALL)
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
    def _parse_doc_structure(cls, text: str) -> list[str]:
        """Parse ## 문서 구조 section into a list of heading lines."""
        m = re.search(r"## 문서 구조\s*\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
        if not m:
            return []
        lines = []
        for line in m.group(1).strip().splitlines():
            line = line.strip().lstrip("- ").strip()
            if line:
                lines.append(line)
        return lines

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
            measurement = self._run_measure(item, output_files, reference_files)
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
                score = min(item.max_score, (value / ceiling) * item.max_score)
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
                if not f.exists():
                    continue
                ref_content += f"## [REF] {f.name}\n{f.read_text()}\n\n"

            system_prompt = (
                "당신은 문서 품질 평가 전문가입니다. "
                "아래 채점 앵커를 엄격하게 적용하여 채점하세요. "
                "경계 점수에서는 내용의 실질적 유용성을 기준으로 판단하세요. "
                "특히 쉼표 나열 남용, 반복 방어 문구(예: '사례 문서에서 직접 확인된'), "
                "국가/지역 섹션 간 분량 불균형을 감점하고 improvements에 수정 대상 섹션명을 포함하세요. "
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
        return EvalOutput(scores=scores, hard_gates=hard_gates, total=round(total, 1))

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
        fn = item.measure_fn

        def _run():
            try:
                r = fn(output_files, reference_files)
                result_container.append(r)
            except Exception as exc:
                error_container.append(exc)

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            logger.error("measure() for '%s' timed out after %ds", item.name, timeout)
            return {"value": 0.0, "detail": f"Timeout after {timeout}s"}

        if error_container:
            logger.error("measure() for '%s' raised: %s", item.name, error_container[0])
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
    previous_score: float | None = None,
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
        previous_score=previous_score,
    )


# ── Spec-driven evaluation builder ──────────────────────────────────
_SPEC_LOOP_FIELDS = (
    "max_iterations",
    "keep_threshold",
    "discard_threshold",
    "convergence_delta",
)


def build_evaluation_from_spec(spec_eval: dict) -> ParsedRubric:
    """Build parsed loop evaluation config from JSONL layer1.evaluation.

    Converts loop config and scoring items (including compiled measure
    functions for quantitative items) into the same ParsedRubric shape
    that RubricParser produces from rubric.md files.
    """
    loop_cfg = spec_eval.get("loop", {})
    config = RubricConfig()
    for field in _SPEC_LOOP_FIELDS:
        if field in loop_cfg:
            setattr(config, field, type(getattr(config, field))(loop_cfg[field]))

    items: list[RubricItem] = []
    for raw_item in spec_eval.get("scoring", {}).get("items", []):
        measure_fn = None
        if raw_item.get("item_type") == "quantitative" and raw_item.get(
            "measure_source"
        ):
            measure_fn = RubricParser._compile_measure(
                raw_item["measure_source"], raw_item.get("id", "unknown")
            )
        items.append(
            RubricItem(
                name=raw_item.get("name", raw_item.get("id", "")),
                item_type=raw_item.get("item_type", "qualitative"),
                max_score=float(raw_item.get("max_score", 0)),
                description=raw_item.get("description", ""),
                hard_gate=float(raw_item["hard_gate"])
                if "hard_gate" in raw_item and raw_item["hard_gate"] is not None
                else None,
                anchors=raw_item.get("anchors") or None,
                measure_fn=measure_fn,
            )
        )

    logger.info(
        "Built ParsedRubric from spec evaluation: %d items, loop=%s",
        len(items),
        {f: getattr(config, f) for f in _SPEC_LOOP_FIELDS if f in loop_cfg},
    )
    return ParsedRubric(config=config, items=items, extra_config={})


# ── run_loop ──────────────────────────────────────────────────────
def run_loop(
    task: TaskProtocol,
    rubric_path: Path | None,
    input_files: list[Path],
    reference_files: list[Path],
    agents: AgentsProtocol,
    output_dir: Path,
    callbacks: LoopCallbacks | None = None,
    context_config: dict | None = None,
) -> LoopReport:
    """Main quality loop entry point."""
    run_id = str(uuid.uuid4())
    cancellation = CancellationToken()

    parsed_override = None
    if context_config:
        parsed_override = context_config.get("_parsed_evaluation_override")

    if parsed_override is not None:
        rubric = parsed_override
    elif rubric_path is not None:
        rubric = RubricParser.parse(rubric_path)
    else:
        raise ValueError(
            "run_loop requires either rubric_path or "
            "context_config['_parsed_evaluation_override']"
        )

    if context_config:
        rubric.extra_config.update(context_config)

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
    first_run_metadata: dict = {}
    last_good_files: list[Path] = []
    # Best-so-far snapshot: tracks the highest-scoring iteration output.
    # The finalizer and subsequent revise passes pull from this snapshot
    # instead of the most recent iteration, so a catastrophic revise can
    # never overwrite a previously good result.
    best_score: float | None = None
    best_files: list[Path] = []
    best_iteration: int = 0
    eval_output: EvalOutput | None = None
    gate_failures: list[HardGateResult] = []

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
                first_run_metadata = result.metadata.copy() if result.metadata else {}
                # Early exit: task signals no work needed (e.g. no changed docs)
                if first_run_metadata.get("skipped"):
                    reason = first_run_metadata.get("reason", "skipped")
                    logger.info("Task skipped (reason=%s). Exiting loop early.", reason)
                    final_dir = output_dir / "final"
                    if result.output_files:
                        final_dir.mkdir(parents=True, exist_ok=True)
                        for f in result.output_files:
                            shutil.copy2(f, final_dir / f.name)
                    skip_files = (
                        list((output_dir / "final").iterdir())
                        if (output_dir / "final").exists()
                        else []
                    )
                    report = LoopReport(
                        status="keep",
                        final_score=100.0,
                        output_files=skip_files,
                        history=[],
                        run_id=run_id,
                        error=None,
                    )
                    _write_report(output_dir / "report.json", report)
                    if first_run_metadata.get("all_docs"):
                        _record_tracker(
                            first_run_metadata,
                            run_id,
                            list(final_dir.iterdir()) if final_dir.exists() else [],
                        )
                    if callbacks and callbacks.on_loop_complete:
                        callbacks.on_loop_complete(report)
                    return report
            else:
                assert eval_output is not None, (
                    "eval_output must be set from iteration 1"
                )
                feedback = _build_feedback(
                    iteration=iteration - 1,
                    eval_result=eval_output,
                    rubric=rubric,
                    gate_failures=gate_failures,
                    # Revise operates on the best-so-far snapshot, not the most
                    # recent iteration. If iter N-1 regressed, we rollback to the
                    # best prior output and retry from there. previous_score is
                    # also the best score, so recovery-mode logic in task.revise
                    # triggers whenever the current iteration is below the best.
                    previous_output_files=best_files or last_good_files,
                    previous_score=best_score,
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

        # Update best-so-far snapshot. Ties go to the later iteration so that
        # a convergent equal-score run uses the most recent output.
        if best_score is None or eval_output.total >= best_score:
            best_score = eval_output.total
            best_files = list(result.output_files)
            best_iteration = iteration
            logger.info(
                "Best snapshot updated: iteration=%d score=%.1f",
                iteration,
                best_score,
            )
        else:
            logger.info(
                "Iteration %d score %.1f below best %.1f (from iter %d) — will rollback for next revise",
                iteration,
                eval_output.total,
                best_score,
                best_iteration,
            )

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

        # Discard: iteration 1에서도 discard_threshold 미만이면 즉시 탈출.
        # 첫 생성 결과가 너무 낮으면 revise로 회복 불가능 (MAP 실패, 파일 접근 불가 등).
        # best_score를 기준으로 판정하므로, 이후 반복에서 점수가 하락해도
        # 이전 iteration이 양호했다면 discard되지 않는다 (롤백으로 보호).
        if best_score is not None and best_score < config.discard_threshold:
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
                _notify_verdict(callbacks, iteration, "converged", eval_output.total)
                break

        # Max iterations check
        if iteration == config.max_iterations:
            record.verdict = "max_iterations"
            history.append(record)
            _notify_verdict(callbacks, iteration, "max_iterations", eval_output.total)
            break

        # Continue with revise
        record.verdict = "revise"
        history.append(record)
        _notify_verdict(callbacks, iteration, "revise", eval_output.total)
        logger.info(
            "PROGRESS iteration=%d verdict=%s score=%.1f",
            iteration,
            record.verdict,
            eval_output.total,
        )
        # Incremental report write (crash resilience)
        _write_incremental_report(output_dir, history, run_id)
        prev_score = eval_output.total

    # Finalize output
    final = history[-1] if history else None
    status = final.verdict if final else "error"
    # final_score reflects the best snapshot across all iterations, not the
    # last iteration's score. A regressive iter_N no longer sinks a good iter_M.
    final_score = best_score if best_score is not None else (
        final.total if final else None
    )

    # Two-threshold Karpathy loop rule:
    # - keep_threshold (e.g. 85): loop TARGET — iterate until this score
    # - discard_threshold (e.g. 70): absolute FLOOR — below this = garbage
    #
    # If max_iterations/converged AND best >= discard but < keep:
    #   → accepted as "best effort" (file saved, pipeline continues)
    # If best < discard: → true discard (garbage, pipeline stops)
    #
    # This avoids the all-or-nothing trap where strict keep_threshold
    # discards every run that didn't hit 85, even with a useful 78.
    did_not_reach_floor = (
        status in ("converged", "max_iterations")
        and best_score is not None
        and best_score < config.discard_threshold
    )
    if did_not_reach_floor:
        logger.warning(
            "Karpathy loop below discard_threshold: best=%.1f floor=%.1f "
            "after %d iterations (original verdict=%s). Downgrading to discard.",
            best_score,
            config.discard_threshold,
            len(history),
            status,
        )
        status = "discard"
        if final is not None:
            final.verdict = "discard"
            if not final.error:
                final.error = (
                    f"Below discard_threshold: best={best_score:.1f} "
                    f"floor={config.discard_threshold:.1f} after {len(history)} iterations"
                )

    # Copy final output — always from the best snapshot, regardless of which
    # iteration it came from. Discards still persist the best attempt under
    # .discarded/ so the run is inspectable, but final_dir stays empty.
    final_dir = output_dir / "final"
    discarded_dir = output_dir / ".discarded"
    snapshot_files = best_files or last_good_files

    if status == "keep":
        final_dir.mkdir(parents=True, exist_ok=True)
        for f in snapshot_files:
            if f.exists():
                shutil.copy2(f, final_dir / f.name)
        logger.info(
            "Final output from best iteration=%d score=%.1f",
            best_iteration,
            best_score if best_score is not None else 0.0,
        )

        # Record to DB only after successful verdict
        if first_run_metadata.get("all_docs"):
            _record_tracker(
                first_run_metadata,
                run_id,
                list(final_dir.iterdir()) if final_dir.exists() else [],
            )

    elif status == "discard":
        discarded_dir.mkdir(parents=True, exist_ok=True)
        for f in snapshot_files:
            if f.exists():
                shutil.copy2(f, discarded_dir / f.name)

    report = LoopReport(
        status=status,
        final_score=final_score,
        output_files=(
            list(final_dir.iterdir())
            if status == "keep" and final_dir.exists()
            else []
        ),
        history=history,
        run_id=run_id,
        error=final.error if final else None,
    )

    logger.info(
        "PROGRESS complete status=%s score=%s",
        report.status,
        report.final_score,
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
    # Also log to output_dir/engine.log when --output is provided
    # (added after basicConfig so stderr handler is preserved)
    import sys as _sys

    for _a in _sys.argv:
        if _a == "--output" and _sys.argv.index(_a) + 1 < len(_sys.argv):
            _log_dir = Path(_sys.argv[_sys.argv.index(_a) + 1])
            _log_dir.mkdir(parents=True, exist_ok=True)
            _fh = logging.FileHandler(_log_dir / "engine.log", encoding="utf-8")
            _fh.setFormatter(
                logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
            )
            logging.getLogger().addHandler(_fh)
            break

    parser = argparse.ArgumentParser(
        description="""Quality Loop Engine (카파시 루프) — rubric 기반 판정 루프 엔진.

task의 실행 결과를 rubric으로 평가하여 keep/revise/discard를 반복 판정한다.
판정 흐름: task.run() → evaluate(rubric) → verdict → task.revise(feedback) → 반복

판정 기준:
  keep:           score >= keep_threshold AND hard gate 모두 통과
  discard:        score < discard_threshold (iteration > 1)
  converged:      0 <= delta < convergence_delta (점수 변화 미미)
  max_iterations: 최대 반복 횟수 도달
  revise:         위 조건 불충족 → 피드백 반영 후 재시도

사용 예시:
  # 1:1 legacy 모드 (파일별 wiki 생성)
  python engine.py --task catalog.tasks.wiki.task.WikiTask \\
    --rubric rubric.md --input "*.md" --output /tmp/out

  # N:1 synthesis 모드 (도메인별 wiki 합성)
  python engine.py --task task.WikiTask \\
    --rubric /path/to/rubric.md \\
    --input "dummy" --output /tmp/out \\
    --domain 안전성검토 \\
    --vault-root ~/Documents/Mywork \\
    --base "3. Resource/LLM Knowledge Base/index/안전성검토.base" \\
    --filter "(안전성검토)_*.md"

  # 로컬 Gemma4 모델 사용 (wiki 생성만, 평가는 gpt-5.4)
  python engine.py --task task.WikiTask \\
    --rubric /path/to/rubric.md \\
    --input "dummy" --output /tmp/out \\
    --domain 안전성검토 --model gemma4-e4b

출력 구조:
  output_dir/
  ├── iter_1/          # 1차 실행 결과
  ├── iter_2/          # 2차 revise 결과
  ├── final/           # keep/converged 시 최종 복사
  ├── .discarded/      # discard 시 이동
  └── report.json      # LoopReport (status, scores, history)
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--task",
        required=True,
        help="Task class (module.ClassName). run(context)→RunResult, revise(context,feedback)→RunResult. 예: task.WikiTask, test_random_task.RandomTask",
    )
    parser.add_argument(
        "--rubric",
        required=False,
        default=None,
        type=Path,
        help="Path to rubric.md (required for CLI execution)",
    )
    parser.add_argument(
        "--input",
        required=False,
        nargs="+",
        default=[],
        help="Input file glob patterns (optional when --domain + --base used)",
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
        default="gpt-5.4",
        help="LLM model. 기본: gpt-5.4 (ChatGPT OAuth). 로컬: gemma4-26b, gemma4-e4b. 평가(reviewer)는 항상 gpt-5.4.",
    )
    parser.add_argument(
        "--domain",
        default=None,
        help="도메인명. 설정 시 N:1 synthesis 모드 활성화. 예: 안전성검토, 첨가물제출. .base에서 raw 문서를 자동 발견.",
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        default=None,
        help="Obsidian vault 루트 경로. --domain과 함께 사용. 예: ~/Documents/Mywork",
    )
    parser.add_argument(
        "--filter",
        default=None,
        help="와일드카드 필터. .base 결과를 추가 필터링. 예: '(안전성검토)_*.md' → 사전안전성검토 제외",
    )
    parser.add_argument(
        "--base",
        type=Path,
        default=None,
        help=".base 인덱스 파일 경로. Obsidian Base 파일로 raw 문서를 자동 발견. 예: index/안전성검토.base",
    )
    parser.add_argument(
        "--wiki-output-dir",
        default=None,
        help="완성된 wiki를 자동 복사할 Obsidian 폴더 경로",
    )

    args = parser.parse_args()

    if args.rubric is None:
        logger.error(
            "--rubric is required for CLI usage; domain-based rubric auto-discovery is not supported"
        )
        raise SystemExit(1)

    # Load task class
    task = _load_task(args.task)

    # Resolve input/reference globs
    input_files = _resolve_globs(args.input)
    reference_files = _resolve_globs(args.reference)

    # In domain mode with --base, input_files can be empty (WikiTask discovers them)
    if not input_files and args.domain is None:
        logger.error("No input files found matching: %s", args.input)
        raise SystemExit(1)

    logger.info("Input files: %d", len(input_files))
    logger.info("Reference files: %d", len(reference_files))

    agents = OpenAIAgents(model=args.model)

    context_config: dict = {}
    if args.domain is not None:
        context_config["domain"] = args.domain
    if args.vault_root is not None:
        context_config["vault_root"] = args.vault_root
    if args.filter is not None:
        context_config["filter"] = args.filter
    if args.base is not None:
        context_config["base_path"] = str(args.base)
    if args.wiki_output_dir is not None:
        context_config["wiki_output_dir"] = args.wiki_output_dir

    report = run_loop(
        task=task,
        rubric_path=args.rubric,
        input_files=input_files,
        reference_files=reference_files,
        agents=agents,
        output_dir=args.output,
        context_config=context_config,
    )

    logger.info(
        "Loop completed: status=%s, score=%s", report.status, report.final_score
    )
    logger.info("Report written to: %s", args.output / "report.json")


def _load_task(task_spec: str) -> TaskProtocol:
    """Load a task class from 'module.ClassName' string."""
    import sys

    if "." not in task_spec:
        raise ValueError(f"Invalid task spec '{task_spec}': must be 'module.ClassName'")
    # Add engine's directory to sys.path for local task modules
    engine_dir = str(Path(__file__).parent)
    if engine_dir not in sys.path:
        sys.path.insert(0, engine_dir)
    src_dir = str(Path(__file__).resolve().parents[3])
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)
    module_path, _, class_name = task_spec.rpartition(".")
    module = importlib.import_module(module_path)
    cls = getattr(module, class_name)
    return cls()


def _record_tracker(metadata: dict, run_id: str, final_files: list[Path]) -> None:
    """Record processed docs to WikiTracker after successful verdict."""
    try:
        import sys as _sys

        engine_dir = str(Path(__file__).parent.parent.parent)
        if engine_dir not in _sys.path:
            _sys.path.insert(0, engine_dir)
        from catalog.tasks.wiki.wiki_tracker import WikiTracker  # type: ignore[import-not-found]

        tracker = WikiTracker()
        all_docs = [Path(p) for p in metadata["all_docs"]]
        domain = metadata.get("domain", "")
        base_path = metadata.get("base_path", "")
        filter_pattern = metadata.get("filter_pattern")

        # Determine output_path (first final file)
        output_path = str(final_files[0]) if final_files else None

        tracker.record_run(run_id, domain, base_path, filter_pattern, all_docs, {})
        tracker.complete_run(
            run_id, output_count=len(final_files), output_path=output_path
        )

        # Auto-copy to wiki output dir if specified (domain-locked)
        wiki_output_dir = metadata.get("wiki_output_dir")
        if wiki_output_dir and final_files and domain:
            allowed_filename = f"{domain}.md"
            dest_dir = Path(wiki_output_dir)
            if dest_dir.exists():
                for f in final_files:
                    if f.name != allowed_filename:
                        logger.warning(
                            "Domain lock: refusing to copy %s (allowed: %s)",
                            f.name,
                            allowed_filename,
                        )
                        continue
                    dest = dest_dir / f.name
                    shutil.copy2(f, dest)
                    logger.info("Auto-copied wiki to %s", dest)

        logger.info(
            "DB recorded: %d docs for domain=%s, output=%s",
            len(all_docs),
            domain,
            output_path,
        )
    except Exception as exc:
        logger.warning("Failed to record to WikiTracker: %s", exc)


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
