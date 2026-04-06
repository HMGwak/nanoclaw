"""OpenAI SDK adapter implementing AgentsProtocol + SubprocessTask adapter."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

import openai

try:
    from catalog.sdk_profiles.chatgpt_oauth import ChatGPTClient
except ImportError:
    try:
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
        from catalog.sdk_profiles.chatgpt_oauth import ChatGPTClient  # type: ignore[no-redef]
    except ImportError:
        ChatGPTClient = None  # type: ignore[assignment,misc]

try:
    from .loop_types import (
        Context,
        EvalResult,
        Feedback,
        ItemScore,
        RunResult,
    )
except ImportError:
    from loop_types import (  # type: ignore[no-redef]
        Context,
        EvalResult,
        Feedback,
        ItemScore,
        RunResult,
    )

logger = logging.getLogger(__name__)


# ── OpenAIAgents ─────────────────────────────────────────────────
class OpenAIAgents:
    """OpenAI SDK adapter implementing AgentsProtocol."""

    def __init__(self, model: str | None = None):
        backend = os.environ.get("NANOCLAW_AGENT_BACKEND", "")

        # Try ChatGPT OAuth first when auth.json exists and no explicit backend override
        if (
            ChatGPTClient is not None
            and ChatGPTClient.AUTH_PATH.exists()
            and backend not in ("zai", "openai-compat", "opencode")
        ):
            self.client = ChatGPTClient(model=model or "gpt-5.4")
            self._use_chatgpt = True
            self.model = model or "gpt-5.4"
            return

        self._use_chatgpt = False

        if backend in ("zai", "openai-compat"):
            api_key = os.environ.get("OPENAI_COMPAT_API_KEY", "")
            base_url = os.environ.get("OPENAI_COMPAT_BASE_URL", "https://api.z.ai/api/paas/v4/")
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "glm-5")
        elif backend == "openai":
            api_key = os.environ.get("OPENAI_API_KEY", "")
            base_url = os.environ.get("OPENAI_BASE_URL") or None
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "gpt-5.4")
        else:  # opencode or other
            api_key = os.environ.get("OPENAI_API_KEY", "") or os.environ.get("OPENCODE_API_KEY", "")
            base_url = os.environ.get("OPENAI_BASE_URL") or None
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "gpt-5.4")

        self.client = openai.OpenAI(api_key=api_key, base_url=base_url)
        self.model = model or default_model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        if self._use_chatgpt:
            return self.client.generate(system_prompt, user_prompt)
        response = self._call_api(system_prompt, user_prompt)
        return response.choices[0].message.content or ""

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
        """Call OpenAI API with retry policy."""
        max_retries = 5
        for attempt in range(max_retries + 1):
            try:
                return self.client.chat.completions.create(
                    model=self.model,
                    max_tokens=8192,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                )
            except openai.RateLimitError:
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
            except openai.InternalServerError:
                if attempt >= 2:
                    raise
                logger.warning(
                    "Server error (5xx), retry %d/3", attempt + 1
                )
            except openai.AuthenticationError:
                raise
            except openai.PermissionDeniedError:
                raise
        raise RuntimeError("Unreachable: API call exhausted retries")


def _extract_json(text: str) -> str:
    """Extract JSON object from LLM response text."""
    import re

    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
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
        if "OPENAI_API_KEY" in os.environ:
            env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
        if "OPENAI_BASE_URL" in os.environ:
            env["OPENAI_BASE_URL"] = os.environ["OPENAI_BASE_URL"]
        model = context.config.get("model", "gpt-5.4")
        env["QUALITY_LOOP_MODEL"] = model
        return env
