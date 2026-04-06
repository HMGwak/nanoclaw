"""Claude SDK adapter implementing AgentsProtocol + SubprocessTask adapter."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anthropic

from .types import (
    Context,
    EvalResult,
    Feedback,
    ItemScore,
    RunResult,
)

logger = logging.getLogger(__name__)


# ── ClaudeAgents ──────────────────────────────────────────────────
class ClaudeAgents:
    """Claude SDK adapter implementing AgentsProtocol."""

    def __init__(self, model: str = "claude-sonnet-4-6"):
        self.client = anthropic.Anthropic()
        self.model = model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self._call_api(system_prompt, user_prompt)
        return response.content[0].text

    def evaluate(
        self,
        system_prompt: str,
        content: str,
        rubric_items: list[dict],
    ) -> EvalResult:
        eval_prompt = f"Evaluate the following content.\n\n{content}\n\nEvaluation items:\n"
        for item in rubric_items:
            eval_prompt += (
                f"- {item['name']} ({item['max_score']} points): {item['description']}\n"
            )
            if item.get("anchors"):
                eval_prompt += f"  Scoring anchors:\n{item['anchors']}\n"
        eval_prompt += (
            '\nRespond in JSON format: {"scores": {"item_name": '
            '{"score": N, "rationale": "...", "improvements": ["..."]}}}'
        )

        last_error: Exception | None = None
        for attempt in range(3):
            raw = self.generate(system_prompt, eval_prompt)
            try:
                parsed = json.loads(_extract_json(raw))
                scores = {
                    k: ItemScore(**v) for k, v in parsed["scores"].items()
                }
                return EvalResult(scores=scores, raw_response=raw)
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                last_error = exc
                logger.warning(
                    "evaluate() JSON parse failed (attempt %d/3): %s",
                    attempt + 1,
                    exc,
                )
                if attempt < 2:
                    continue
        raise ValueError(
            f"evaluate() failed after 3 attempts: {last_error}"
        )

    def _call_api(self, system_prompt: str, user_prompt: str) -> Any:
        """Call Anthropic API with retry policy."""
        max_retries = 5
        for attempt in range(max_retries + 1):
            try:
                return self.client.messages.create(
                    model=self.model,
                    max_tokens=8192,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_prompt}],
                )
            except anthropic.RateLimitError:
                if attempt >= max_retries:
                    raise
                delay = min(2**attempt, 16)
                logger.warning(
                    "Rate limited (429), retry %d/%d after %ds",
                    attempt + 1,
                    max_retries,
                    delay,
                )
                time.sleep(delay)
            except anthropic.InternalServerError:
                if attempt >= 2:
                    raise
                logger.warning(
                    "Server error (5xx), retry %d/3", attempt + 1
                )
            except anthropic.AuthenticationError:
                raise
            except anthropic.PermissionDeniedError:
                raise
        raise RuntimeError("Unreachable: API call exhausted retries")


def _extract_json(text: str) -> str:
    """Extract JSON object from LLM response text."""
    # Try to find JSON block in markdown code fence
    import re

    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Try to find raw JSON object
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


# ── SubprocessTask ────────────────────────────────────────────────
class SubprocessTask:
    """Out-of-process task adapter implementing TaskProtocol."""

    def __init__(self, command_template: str):
        self.command_template = command_template

    def run(self, context: Context) -> RunResult:
        input_str = " ".join(str(f) for f in context.input_files)
        cmd = self.command_template.format(
            input_files=input_str,
            output_dir=str(context.output_dir),
        )
        env = self._build_env(context)
        before_files = set(context.output_dir.rglob("*"))

        result = subprocess.run(
            shlex.split(cmd),
            env=env,
            capture_output=True,
            text=True,
            timeout=context.config.get(
                "task_timeout_seconds", 300
            ),
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"Subprocess failed (exit {result.returncode}): {result.stderr}"
            )

        after_files = set(context.output_dir.rglob("*"))
        new_files = sorted(f for f in after_files - before_files if f.is_file())
        return RunResult(output_files=new_files)

    def revise(self, context: Context, feedback: Feedback) -> RunResult:
        # Serialize feedback to JSON file
        feedback_path = context.output_dir / ".feedback.json"
        feedback_data = {
            "iteration": feedback.iteration,
            "total_score": feedback.total_score,
            "items": [
                {
                    "name": item.name,
                    "score": item.score,
                    "max_score": item.max_score,
                    "rationale": item.rationale,
                    "improvements": item.improvements,
                }
                for item in feedback.items
            ],
            "hard_gate_failures": [
                {
                    "name": g.name,
                    "measured": g.measured,
                    "threshold": g.threshold,
                    "message": g.message,
                }
                for g in feedback.hard_gate_failures
            ],
            "previous_output_files": [
                str(f) for f in feedback.previous_output_files
            ],
        }
        feedback_path.write_text(json.dumps(feedback_data, ensure_ascii=False, indent=2))

        input_str = " ".join(str(f) for f in context.input_files)
        cmd = self.command_template.format(
            input_files=input_str,
            output_dir=str(context.output_dir),
        )
        cmd += f" --feedback {shlex.quote(str(feedback_path))}"

        env = self._build_env(context)
        before_files = set(context.output_dir.rglob("*"))

        result = subprocess.run(
            shlex.split(cmd),
            env=env,
            capture_output=True,
            text=True,
            timeout=context.config.get(
                "task_timeout_seconds", 300
            ),
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"Subprocess revise failed (exit {result.returncode}): {result.stderr}"
            )

        after_files = set(context.output_dir.rglob("*"))
        new_files = sorted(
            f
            for f in after_files - before_files
            if f.is_file() and f.name != ".feedback.json"
        )
        return RunResult(output_files=new_files)

    def _build_env(self, context: Context) -> dict[str, str]:
        env = os.environ.copy()
        env["QUALITY_LOOP_RUN_ID"] = context.run_id
        if "ANTHROPIC_API_KEY" in os.environ:
            env["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]
        model = context.config.get("model", "claude-sonnet-4-6")
        env["QUALITY_LOOP_MODEL"] = model
        return env
