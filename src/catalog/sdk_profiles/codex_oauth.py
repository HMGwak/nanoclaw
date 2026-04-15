#!/usr/bin/env python3
"""Codex SDK bridge for nanoclaw wiki MAP.

Calls the Node.js codex_bridge.mjs via subprocess to invoke Codex SDK.
Runs with an isolated CODEX_HOME rooted at `nanoclaw/temp/codex-local/`
so that the user's global `~/.codex/` state is neither read nor
mutated by wiki synthesis. Auth is synced one-way from the real
`~/.codex/auth.json` into the isolated home on each call.
Adapted from F_nextboat2_toxprofile_maker/tooling/codex_local.py.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
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
    'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n'
)


def _ensure_local_home() -> None:
    """Create isolated CODEX_HOME directory and sync auth.json.

    Codex CLI treats CODEX_HOME as the equivalent of `~/.codex` itself
    (not a parent containing `.codex/`), so files live **directly**
    under CODEX_HOME: `$CODEX_HOME/auth.json`, `$CODEX_HOME/config.toml`.
    """
    _CODEX_HOME.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(_CODEX_HOME_CONFIG, encoding="utf-8")

    # Sync auth.json from real ~/.codex/auth.json directly into CODEX_HOME
    real_auth = Path.home() / ".codex" / "auth.json"
    local_auth = _CODEX_HOME / "auth.json"
    if real_auth.exists() and (
        not local_auth.exists()
        or real_auth.stat().st_mtime > local_auth.stat().st_mtime
    ):
        shutil.copy2(str(real_auth), str(local_auth))
        logger.info("Synced auth.json to isolated CODEX_HOME")


def _build_local_env() -> dict[str, str]:
    """Build environment for Codex bridge.

    Initializes an isolated `CODEX_HOME` under the nanoclaw repo so that
    Codex never reads or mutates the user's global `~/.codex/` state.
    On Linux/Docker, also disables the bwrap sandbox because its
    namespace creation fails when spawned from a subprocess context.
    """
    _ensure_local_home()
    env: dict[str, str] = {k: v for k, v in os.environ.items() if v}
    env["CODEX_HOME"] = str(_CODEX_HOME)
    if sys.platform != "darwin":
        # Linux/Docker only: Codex's internal bwrap cannot open a new
        # namespace from inside an existing subprocess, so the CLI
        # refuses to start without this escape hatch. macOS uses the
        # native Seatbelt sandbox and does not need it.
        env.setdefault("CODEX_SANDBOX_MODE", "off")
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
        return {
            "ok": False,
            "code": "NODE_NOT_FOUND",
            "message": "Node.js is required.",
            "details": {},
        }
    if not _BRIDGE_PATH.exists():
        return {
            "ok": False,
            "code": "BRIDGE_NOT_FOUND",
            "message": f"Bridge not found: {_BRIDGE_PATH}",
            "details": {},
        }

    completed = subprocess.run(
        [node_path, str(_BRIDGE_PATH), "--probe", probe, "--json"],
        input=(
            json.dumps(stdin_payload, ensure_ascii=False).encode("utf-8")
            if stdin_payload is not None
            else None
        ),
        capture_output=True,
        text=False,
        timeout=timeout_s,
        env=_build_local_env(),
        cwd=str(_REPO_ROOT),
    )

    stdout = (completed.stdout or b"").decode("utf-8", errors="replace").strip()
    stderr = (completed.stderr or b"").decode("utf-8", errors="replace").strip()
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
        "message": (stderr or stdout or "Bridge returned invalid JSON.").strip(),
        "details": {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": completed.returncode,
        },
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
    timeout_s: float = 3600.0,
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

    response = _run_bridge(
        "exec", stdin_payload=payload, timeout_s=max(timeout_s + 10.0, 30.0)
    )
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
