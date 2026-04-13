"""SpecLoader: reads domainSpecs.jsonl and returns spec entries by domain/layer/type.

This is a standalone loader module — it does NOT wire into runtime (engine,
synthesizer, runner). Runtime wiring happens in a later task.

Usage::

    loader = SpecLoader()                       # uses SPEC_PATH env or auto-discovers
    loader = SpecLoader(spec_path=Path("..."))   # explicit path

    all_specs = loader.load_specs("regulation", "layer1")
    extract  = loader.load_extract_prompt("regulation", "layer1")
    compose  = loader.load_compose_prompt("regulation", "layer1")
    eval_    = loader.load_evaluation("regulation", "layer1")
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

# ── JSONL entry types the loader recognises ────────────────────────
_SPEC_TYPE_RE = re.compile(
    r"^(structure|layer\d+\.schema\.contract|layer\d+\.prompt\.(extract|compose|update|revise)|layer\d+\.evaluation)$"
)

# Fields required on *every* spec entry (except the structure tree which
# has a slightly different shape but still carries domain/version).
_REQUIRED_FIELDS = ("type", "domain", "layer", "version")

# Allowed version pattern (from schema contract).
_VERSION_RE = re.compile(r"^v[0-9]+$")


class SpecValidationError(Exception):
    """Raised when the JSONL file is malformed or contains invalid entries."""


def _is_supported_spec_type(entry_type: str) -> bool:
    return bool(_SPEC_TYPE_RE.match(entry_type))


def _discover_spec_path() -> Path:
    """Find the JSONL spec file.

    Resolution order:
    1. ``SPEC_PATH`` environment variable (absolute or relative to cwd).
    2. Hard-coded path inside the nextboat-information repo that is the
       canonical location established in Tasks 1-4.
    """
    env = os.environ.get("SPEC_PATH")
    if env:
        p = Path(env)
        if not p.is_file():
            raise SpecValidationError(
                f"SPEC_PATH env var points to non-existent file: {p}"
            )
        return p

    # Default: the canonical JSONL established in the main repo.
    default = (
        Path.home()
        / "Projects/nextboat-information"
        / "desktop/tauri-app/src/features/information/specs/domainSpecs.jsonl"
    )
    if default.is_file():
        return default

    raise SpecValidationError(
        "Cannot discover spec file: SPEC_PATH env not set and "
        f"default path does not exist ({default})"
    )


def _parse_jsonl(
    spec_path: Path,
) -> tuple[list[dict[str, Any]], dict[tuple[str, str, str], dict[str, Any]]]:
    entries: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()

    raw = spec_path.read_text(encoding="utf-8")
    for line_num, raw_line in enumerate(raw.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SpecValidationError(
                f"Line {line_num}: malformed JSON — {exc}"
            ) from exc

        if not isinstance(obj, dict):
            raise SpecValidationError(
                f"Line {line_num}: expected a JSON object, got {type(obj).__name__}"
            )

        entry_type = obj.get("type")
        has_tree = "tree" in obj

        if not entry_type and has_tree:
            entry_type = "structure"
            obj["type"] = "structure"
        elif not entry_type:
            raise SpecValidationError(f"Line {line_num}: missing 'type' field")

        # Structure entries may not have 'layer';
        # everything else must have all four required fields.
        if entry_type == "structure":
            if "domain" not in obj or "version" not in obj:
                raise SpecValidationError(
                    f"Line {line_num}: structure entry missing 'domain' or 'version'"
                )
            obj.setdefault("layer", "")
        else:
            for field in _REQUIRED_FIELDS:
                if field not in obj:
                    raise SpecValidationError(
                        f"Line {line_num} ({entry_type}): "
                        f"missing required field '{field}'"
                    )

        if not _is_supported_spec_type(entry_type):
            raise SpecValidationError(
                f"Line {line_num}: unsupported spec type '{entry_type}'"
            )

        version = obj.get("version", "")
        if not _VERSION_RE.match(str(version)):
            raise SpecValidationError(
                f"Line {line_num} ({entry_type}): version "
                f"'{version}' does not match ^v[0-9]+$"
            )

        domain_val = obj.get("domain", "")
        layer_val = obj.get("layer", "")
        key = (domain_val, layer_val, entry_type)
        if key in seen_keys:
            raise SpecValidationError(
                f"Line {line_num}: duplicate entry for "
                f"(domain={domain_val!r}, layer={layer_val!r}, "
                f"type={entry_type!r})"
            )
        seen_keys.add(key)

        entries.append(obj)

    index = {(e.get("domain", ""), e.get("layer", ""), e["type"]): e for e in entries}
    return entries, index


class SpecLoader:
    """Load and query domain spec entries from a JSONL file."""

    def __init__(self, spec_path: Path | None = None) -> None:
        self._spec_path = spec_path
        self._entries: list[dict[str, Any]] | None = None
        self._index: dict[tuple[str, str, str], dict[str, Any]] | None = None

    def load_specs(
        self,
        arg1: Path | str,
        arg2: str,
        arg3: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Return spec entries matching domain and layer.

        Two call styles:

        1. Plan contract (path-aware):
               ``load_specs(spec_path, domain, layer)``
           Parses from the given path and returns matching entries.

        2. Convenience (uses constructor/env path):
               ``load_specs(domain, layer)``
           Uses the path set at construction or auto-discovered.

        Returns a dict keyed by spec ``type`` (e.g.
        ``"layer1.prompt.extract"``). Returns an empty dict on no match.
        """
        if arg3 is not None:
            return self._load_from_path(Path(arg1), arg2, arg3)
        return self._query_index(str(arg1), arg2)

    def load_extract_prompt(self, domain: str, layer: str) -> str | None:
        entry = self._find(domain, layer, f"{layer}.prompt.extract")
        return entry.get("prompt") if entry else None

    def load_compose_prompt(self, domain: str, layer: str) -> str | None:
        entry = self._find(domain, layer, f"{layer}.prompt.compose")
        return entry.get("prompt") if entry else None

    def load_update_prompt(self, domain: str, layer: str) -> str | None:
        entry = self._find(domain, layer, f"{layer}.prompt.update")
        return entry.get("prompt") if entry else None

    def load_revise_prompt(self, domain: str, layer: str) -> str | None:
        entry = self._find(domain, layer, f"{layer}.prompt.revise")
        return entry.get("prompt") if entry else None

    def load_evaluation(self, domain: str, layer: str) -> dict | None:
        return self._find(domain, layer, f"{layer}.evaluation")

    # ── Internal ────────────────────────────────────────────────────

    def _load_from_path(
        self, spec_path: Path, domain: str, layer: str
    ) -> dict[str, dict[str, Any]]:
        if not spec_path.is_file():
            raise SpecValidationError(f"Spec file not found: {spec_path}")
        _, index = _parse_jsonl(spec_path)
        return {
            spec_type: entry
            for (d, l, spec_type), entry in index.items()
            if d == domain and l == layer
        }

    def _query_index(self, domain: str, layer: str) -> dict[str, dict[str, Any]]:
        self._ensure_loaded()
        assert self._index is not None
        return {
            spec_type: entry
            for (d, l, spec_type), entry in self._index.items()
            if d == domain and l == layer
        }

    def _find(self, domain: str, layer: str, spec_type: str) -> dict[str, Any] | None:
        self._ensure_loaded()
        assert self._index is not None
        return self._index.get((domain, layer, spec_type))

    def _ensure_loaded(self) -> None:
        if self._entries is not None:
            return
        resolved = self._spec_path or _discover_spec_path()
        self._spec_path = resolved
        if not self._spec_path.is_file():
            raise SpecValidationError(f"Spec file not found: {self._spec_path}")
        self._entries, self._index = _parse_jsonl(self._spec_path)
