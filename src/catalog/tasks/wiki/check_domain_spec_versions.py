from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]

SPEC_PATH = (
    REPO_ROOT
    / "src"
    / "catalog"
    / "tasks"
    / "wiki"
    / "specs"
    / "tobacco_regulation.json"
)

PROMPT_SURFACE_FILES = [
    REPO_ROOT / "src" / "catalog" / "tasks" / "wiki" / "synthesizer.py",
    REPO_ROOT / "src" / "catalog" / "tasks" / "wiki" / "task.py",
    REPO_ROOT / "src" / "catalog" / "tasks" / "wiki" / "run_wiki.py",
    REPO_ROOT / "src" / "catalog" / "tasks" / "wiki" / "spec_loader.py",
]


def _load_json(text: str) -> dict:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("spec json must be an object")
    return data


def _version_num(value: str) -> int:
    if not value.startswith("v") or not value[1:].isdigit():
        raise ValueError(f"invalid version: {value}")
    return int(value[1:])


def _extract_prompt_surface_version(text: str, file_path: Path) -> str:
    match = re.search(r'PROMPT_SURFACE_VERSION\s*=\s*"(v\d+)"', text)
    if not match:
        raise ValueError(f"missing PROMPT_SURFACE_VERSION in {file_path}")
    return match.group(1)


def main() -> int:
    current_text = SPEC_PATH.read_text(encoding="utf-8")
    current = _load_json(current_text)

    proc = subprocess.run(
        ["git", "show", f"HEAD~1:{SPEC_PATH.relative_to(REPO_ROOT)}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print("No HEAD version available for comparison; skipping bump check.")
        return 0

    previous = _load_json(proc.stdout)
    failures: list[str] = []

    if current != previous:
        prev_ver = previous.get("version")
        cur_ver = current.get("version")
        if not prev_ver or not cur_ver:
            failures.append("spec changed without version field")
        elif _version_num(cur_ver) <= _version_num(prev_ver):
            failures.append(f"spec version did not increase ({prev_ver} -> {cur_ver})")

    if failures:
        print("Spec version check failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    for prompt_file in PROMPT_SURFACE_FILES:
        current_text = prompt_file.read_text(encoding="utf-8")
        proc = subprocess.run(
            ["git", "show", f"HEAD~1:{prompt_file.relative_to(REPO_ROOT)}"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            continue
        previous_text = proc.stdout
        if current_text == previous_text:
            continue
        try:
            prev_ver = _extract_prompt_surface_version(previous_text, prompt_file)
        except ValueError:
            continue
        cur_ver = _extract_prompt_surface_version(current_text, prompt_file)
        if _version_num(cur_ver) <= _version_num(prev_ver):
            print("Spec version check failed:")
            print(
                f"- prompt surface {prompt_file}: version did not increase ({prev_ver} -> {cur_ver})"
            )
            return 1

    print("Spec version check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
