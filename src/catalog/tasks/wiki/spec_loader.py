"""SpecLoader for domain-scoped JSON wiki specs."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

_VERSION_RE = re.compile(r"^v[0-9]+$")


class SpecValidationError(Exception):
    """Raised when the spec file is malformed or invalid."""


class SpecLoader:
    """Load and query a domain-scoped JSON spec tree."""

    def __init__(self, spec_path: Path | None = None) -> None:
        self._spec_path = spec_path
        self._cache: dict[str, dict[str, Any]] = {}

    def load_specs(
        self,
        arg1: Path | str,
        arg2: str,
        arg3: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        if arg3 is not None:
            spec = self._load_domain_from_file(Path(arg1), arg2)
            return self._layer_entries(spec, arg3)
        spec = self.load_domain(str(arg1))
        return self._layer_entries(spec, arg2)

    def load_domain(self, domain: str) -> dict[str, Any]:
        if domain in self._cache:
            return self._cache[domain]
        path = self._resolve_spec_path(domain)
        spec = self._load_domain_from_file(path, domain)
        self._cache[domain] = spec
        return spec

    def load_layers(self, domain: str) -> list[str]:
        spec = self.load_domain(domain)
        layers = list((spec.get("layers") or {}).keys())
        return sorted(layers, key=_layer_sort_key)

    def load_structure(self, domain: str) -> dict[str, Any] | None:
        spec = self.load_domain(domain)
        return spec.get("structure")

    def load_shared_prompt_rules(self, domain: str) -> dict[str, Any]:
        spec = self.load_domain(domain)
        rules = spec.get("shared_prompt_rules") or {}
        if not isinstance(rules, dict):
            raise SpecValidationError("shared_prompt_rules must be an object")
        return rules

    def load_extract_prompt(self, domain: str, layer: str) -> str | None:
        return self._load_prompt(domain, layer, "extract")

    def load_compose_prompt(self, domain: str, layer: str) -> str | None:
        return self._load_prompt(domain, layer, "compose")

    def load_update_prompt(self, domain: str, layer: str) -> str | None:
        return self._load_prompt(domain, layer, "update")

    def load_revise_prompt(self, domain: str, layer: str) -> str | None:
        return self._load_prompt(domain, layer, "revise")

    def load_evaluation(self, domain: str, layer: str) -> dict[str, Any] | None:
        spec = self.load_domain(domain)
        layer_obj = self._get_layer(spec, layer)
        evaluation = layer_obj.get("evaluation")
        if evaluation is None:
            return None
        if not isinstance(evaluation, dict):
            raise SpecValidationError(f"layers.{layer}.evaluation must be an object")
        return evaluation

    def load_source(self, domain: str, layer: str) -> dict[str, Any] | None:
        spec = self.load_domain(domain)
        layer_obj = self._get_layer(spec, layer)
        source = layer_obj.get("source")
        if source is None:
            return None
        if not isinstance(source, dict):
            raise SpecValidationError(f"layers.{layer}.source must be an object")
        return source

    def _load_prompt(self, domain: str, layer: str, kind: str) -> str | None:
        spec = self.load_domain(domain)
        layer_obj = self._get_layer(spec, layer)
        prompt_obj = layer_obj.get("prompt") or {}
        if not isinstance(prompt_obj, dict):
            raise SpecValidationError(f"layers.{layer}.prompt must be an object")
        value = prompt_obj.get(kind)
        if value is None:
            return None
        if isinstance(value, dict):
            prompt = value.get("prompt")
            return str(prompt) if prompt is not None else None
        return str(value)

    def _layer_entries(
        self, spec: dict[str, Any], layer: str
    ) -> dict[str, dict[str, Any]]:
        if layer == "":
            structure = spec.get("structure")
            if structure is None:
                return {}
            return {
                "structure": {
                    "type": "structure",
                    "domain": spec["domain"],
                    "layer": "",
                    "version": spec["version"],
                    "tree": {"structure": structure},
                }
            }

        layer_obj = self._get_layer(spec, layer)
        result: dict[str, dict[str, Any]] = {}

        source = layer_obj.get("source")
        if isinstance(source, dict) and source:
            result[f"{layer}.source"] = {
                "type": f"{layer}.source",
                "domain": spec["domain"],
                "layer": layer,
                "version": source.get("version", spec["version"]),
                "source": source,
            }

        prompt_obj = layer_obj.get("prompt") or {}
        if isinstance(prompt_obj, dict):
            for kind, raw in prompt_obj.items():
                entry = raw if isinstance(raw, dict) else {"prompt": raw}
                result[f"{layer}.prompt.{kind}"] = {
                    "type": f"{layer}.prompt.{kind}",
                    "domain": spec["domain"],
                    "layer": layer,
                    "version": entry.get("version", spec["version"]),
                    **entry,
                }

        evaluation = layer_obj.get("evaluation")
        if isinstance(evaluation, dict):
            result[f"{layer}.evaluation"] = {
                "type": f"{layer}.evaluation",
                "domain": spec["domain"],
                "layer": layer,
                "version": evaluation.get("version", spec["version"]),
                **evaluation,
            }

        contract = layer_obj.get("contract")
        if isinstance(contract, dict):
            result[f"{layer}.schema.contract"] = {
                "type": f"{layer}.schema.contract",
                "domain": spec["domain"],
                "layer": layer,
                "version": contract.get("version", spec["version"]),
                **contract,
            }

        return result

    def _get_layer(self, spec: dict[str, Any], layer: str) -> dict[str, Any]:
        layers = spec.get("layers") or {}
        if not isinstance(layers, dict):
            raise SpecValidationError("layers must be an object")
        layer_obj = layers.get(layer)
        if not isinstance(layer_obj, dict):
            return {}
        return layer_obj

    def _resolve_spec_path(self, domain: str) -> Path:
        if self._spec_path is not None:
            return self._spec_path

        env = os.environ.get("SPEC_PATH")
        if env:
            p = Path(env)
            if not p.is_file():
                raise SpecValidationError(
                    f"SPEC_PATH env var points to non-existent file: {p}"
                )
            return p

        default_dir = Path(__file__).resolve().parent / "specs"
        path = default_dir / f"{domain}.json"
        if path.is_file():
            return path

        raise SpecValidationError(f"Spec file not found: {path}")

    def _load_domain_from_file(
        self, spec_path: Path, expected_domain: str
    ) -> dict[str, Any]:
        if not spec_path.is_file():
            raise SpecValidationError(f"Spec file not found: {spec_path}")
        try:
            obj = json.loads(spec_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SpecValidationError(f"Malformed JSON spec: {exc}") from exc
        if not isinstance(obj, dict):
            raise SpecValidationError("Spec file must be a JSON object")
        domain = obj.get("domain")
        version = obj.get("version")
        if not domain or not version:
            raise SpecValidationError("Spec missing required 'domain' or 'version'")
        if domain != expected_domain:
            return {"domain": expected_domain, "version": version, "layers": {}}
        if not _VERSION_RE.match(str(version)):
            raise SpecValidationError(f"Invalid version: {version}")
        if not isinstance(obj.get("layers", {}), dict):
            raise SpecValidationError("Spec 'layers' must be an object")
        return obj


def _layer_sort_key(layer_name: str) -> tuple[int, str]:
    m = re.fullmatch(r"layer(\d+)", layer_name)
    if m:
        return (int(m.group(1)), layer_name)
    return (9999, layer_name)
