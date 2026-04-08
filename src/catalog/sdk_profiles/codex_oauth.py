#!/usr/bin/env python3
"""Codex SDK bridge for nanoclaw wiki MAP.

Calls the Node.js codex_bridge.mjs via subprocess to invoke Codex SDK.
Uses CODEX_HOME isolation so on-disk global Codex state is ignored.
Adapted from F_nextboat2_toxprofile_maker/tooling/codex_local.py.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_SCRIPT_DIR = Path(__file__).parent
_REPO_ROOT = _SCRIPT_DIR.parent.parent.parent  # nanoclaw/
_BRIDGE_PATH = _REPO_ROOT / "runtime" / "codex_bridge.mjs"
_STATE_ROOT = _REPO_ROOT / "temp" / "codex-local"
_CODEX_HOME = _STATE_ROOT / "home"
_CONFIG_PATH = _CODEX_HOME / "config.toml"
_CODEX_HOME_CONFIG = (
    'cli_auth_credentials_store = "file"\n'
    'forced_login_method = "chatgpt"\n'
)


def _ensure_local_home() -> None:
    """Create isolated CODEX_HOME directory structure and sync auth."""
    _CODEX_HOME.mkdir(parents=True, exist_ok=True)
    (_CODEX_HOME / ".config").mkdir(parents=True, exist_ok=True)
    (_CODEX_HOME / ".cache").mkdir(parents=True, exist_ok=True)
    (_CODEX_HOME / ".state").mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(_CODEX_HOME_CONFIG, encoding="utf-8")

    # Sync auth.json from real ~/.codex/ to isolated home
    real_auth = Path.home() / ".codex" / "auth.json"
    local_codex_dir = _CODEX_HOME / ".codex"
    local_codex_dir.mkdir(parents=True, exist_ok=True)
    local_auth = local_codex_dir / "auth.json"
    if real_auth.exists() and (
        not local_auth.exists()
        or real_auth.stat().st_mtime > local_auth.stat().st_mtime
    ):
        shutil.copy2(str(real_auth), str(local_auth))
        logger.info("Synced auth.json to isolated CODEX_HOME")


def _build_local_env() -> dict[str, str]:
    """Build environment for Codex bridge.

    Uses real HOME for auth access. Isolation is only needed in Docker
    where ~/.codex is mounted read-only.
    """
    env: dict[str, str] = {k: v for k, v in os.environ.items() if v}
    # Keep real HOME so Codex finds ~/.codex/auth.json
    return env


def _run_bridge(
    probe: str,
    *,
    stdin_payload: dict[str, Any] | None = None,
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """Run codex_bridge.mjs with given probe command."""
    node_path = shutil.which("node")
    if not node_path:
        return {"ok": False, "code": "NODE_NOT_FOUND", "message": "Node.js is required.", "details": {}}
    if not _BRIDGE_PATH.exists():
        return {"ok": False, "code": "BRIDGE_NOT_FOUND", "message": f"Bridge not found: {_BRIDGE_PATH}", "details": {}}

    completed = subprocess.run(
        [node_path, str(_BRIDGE_PATH), "--probe", probe, "--json"],
        input=(json.dumps(stdin_payload, ensure_ascii=False) if stdin_payload is not None else None),
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env=_build_local_env(),
        cwd=str(_REPO_ROOT),
    )

    stdout = (completed.stdout or "").strip()
    if stdout:
        try:
            payload = json.loads(stdout)
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            pass

    return {
        "ok": False,
        "code": "INVALID_BRIDGE_RESPONSE",
        "message": (completed.stderr or stdout or "Bridge returned invalid JSON.").strip(),
        "details": {"stdout": stdout, "stderr": (completed.stderr or "").strip(), "exit_code": completed.returncode},
    }


def check_runtime() -> dict[str, Any]:
    """Check if Codex SDK runtime is available."""
    return _run_bridge("runtime", timeout_s=15.0)


def run_codex_prompt(
    prompt: str,
    *,
    cwd: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    timeout_s: float = 600.0,
    output_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a prompt via Codex SDK and return structured result.

    Returns:
        dict with keys: ok, code, message, output (final response text), details
    """
    payload: dict[str, Any] = {
        "prompt": prompt,
        "cwd": cwd or str(_REPO_ROOT),
        "timeout_ms": int(timeout_s * 1000),
    }
    if model:
        payload["model"] = model
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    if output_schema:
        payload["output_schema"] = output_schema

    response = _run_bridge("exec", stdin_payload=payload, timeout_s=max(timeout_s + 10.0, 30.0))
    details = response.get("details") or {}
    final_response = details.get("final_response") if isinstance(details, dict) else ""

    return {
        "ok": bool(response.get("ok", False)) and response.get("code") == "EXEC_OK",
        "code": response.get("code", "EXEC_FAILED"),
        "message": response.get("message", "Codex execution failed."),
        "output": final_response if isinstance(final_response, str) else "",
        "details": details if isinstance(details, dict) else {},
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "health":
        result = check_runtime()
    elif len(sys.argv) > 1 and sys.argv[1] == "test":
        result = run_codex_prompt(
            "Return a JSON object with key 'hello' and value 'world'.",
            reasoning_effort="low",
            timeout_s=60.0,
        )
    else:
        print("Usage: python codex_oauth.py [health|test]")
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))
