from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent.parent
_src = _project_root / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

_loader = importlib.import_module("catalog.tasks.wiki.spec_loader")
SpecLoader = _loader.SpecLoader
SpecValidationError = _loader.SpecValidationError

passed = 0
failed = 0


def record_check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def _make_spec_json(data: dict) -> Path:
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    )
    json.dump(data, tmp, ensure_ascii=False)
    tmp.close()
    return Path(tmp.name)


def _valid_spec() -> dict:
    return {
        "domain": "tobacco_regulation",
        "version": "v1",
        "structure": {"title": "root", "sections": {}},
        "shared_prompt_rules": {
            "extract": "SHARED EXTRACT",
            "compose": "SHARED COMPOSE",
        },
        "runner": {},
        "layers": {
            "layer1": {
                "source": {"view": "Tobacco Law"},
                "prompt": {
                    "extract": {"version": "v1", "prompt": "extract prompt here"},
                    "compose": {"version": "v1", "prompt": "compose prompt here"},
                },
                "evaluation": {
                    "version": "v1",
                    "loop": {"max_iterations": 3},
                    "scoring": {"items": []},
                },
            },
            "layer2": {
                "source": {"view": "Law Reviews"},
                "prompt": {
                    "update": {"version": "v1", "prompt": "update prompt here"},
                    "revise": {"version": "v1", "prompt": "revise prompt here"},
                },
                "evaluation": {
                    "version": "v1",
                    "loop": {"max_iterations": 2},
                    "scoring": {"items": []},
                },
            },
        },
    }


print("\n=== Valid Load ===")
path = _make_spec_json(_valid_spec())
loader = SpecLoader(spec_path=path)
all_specs = loader.load_specs("tobacco_regulation", "layer1")
record_check(
    "load_specs returns source/extract/compose/evaluation",
    len(all_specs) == 4,
    f"got {len(all_specs)}",
)
record_check("has source", "layer1.source" in all_specs)
record_check("has extract", "layer1.prompt.extract" in all_specs)
record_check("has compose", "layer1.prompt.compose" in all_specs)
record_check("has evaluation", "layer1.evaluation" in all_specs)
record_check(
    "extract prompt returned",
    loader.load_extract_prompt("tobacco_regulation", "layer1") == "extract prompt here",
)
record_check(
    "compose prompt returned",
    loader.load_compose_prompt("tobacco_regulation", "layer1") == "compose prompt here",
)
record_check(
    "source returned",
    loader.load_source("tobacco_regulation", "layer1") == {"view": "Tobacco Law"},
)
record_check(
    "layers returned in order",
    loader.load_layers("tobacco_regulation") == ["layer1", "layer2"],
)
record_check(
    "shared rules available",
    loader.load_shared_prompt_rules("tobacco_regulation")["extract"]
    == "SHARED EXTRACT",
)
record_check("structure found", loader.load_structure("tobacco_regulation") is not None)
path.unlink()

print("\n=== Malformed JSON ===")
bad = tempfile.NamedTemporaryFile(
    mode="w", suffix=".json", delete=False, encoding="utf-8"
)
bad.write("not-json")
bad.close()
try:
    SpecLoader(spec_path=Path(bad.name)).load_specs("x", "y")
    record_check("malformed JSON raises", False, "no exception")
except SpecValidationError as e:
    record_check(
        "malformed JSON raises SpecValidationError", "Malformed JSON spec" in str(e)
    )
Path(bad.name).unlink()

print("\n=== No-Match Fallback ===")
p = _make_spec_json(_valid_spec())
loader = SpecLoader(spec_path=p)
record_check(
    "no-match load_specs returns empty dict",
    loader.load_specs("nonexistent", "layer1") == {},
)
record_check(
    "no-match extract returns None",
    loader.load_extract_prompt("nonexistent", "layer1") is None,
)
record_check(
    "no-match evaluation returns None",
    loader.load_evaluation("nonexistent", "layer1") is None,
)
p.unlink()

print("\n=== ENV VAR Discovery ===")
p_env = _make_spec_json(_valid_spec())
os.environ["SPEC_PATH"] = str(p_env)
try:
    loader_env = SpecLoader()
    specs = loader_env.load_specs("tobacco_regulation", "layer1")
    record_check("SPEC_PATH env picks up file", len(specs) == 4)
finally:
    del os.environ["SPEC_PATH"]
p_env.unlink()

print("\n=== Real JSON integration ===")
real_path = (
    Path(__file__).resolve().parent.parent.parent
    / "src"
    / "catalog"
    / "tasks"
    / "wiki"
    / "specs"
    / "tobacco_regulation.json"
)
if real_path.is_file():
    real_loader = SpecLoader(spec_path=real_path)
    real_specs = real_loader.load_specs("tobacco_regulation", "layer1")
    record_check(
        "real JSON loads", len(real_specs) >= 4, f"got {len(real_specs)} entries"
    )
    record_check("real JSON has source", "layer1.source" in real_specs)
    record_check("real JSON has extract", "layer1.prompt.extract" in real_specs)
    record_check("real JSON has compose", "layer1.prompt.compose" in real_specs)
    record_check("real JSON has evaluation", "layer1.evaluation" in real_specs)
else:
    print("  SKIP  real JSON not found")

print(f"\n{'=' * 50}")
print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")


def test_spec_loader_smoke() -> None:
    assert failed == 0, f"{failed} smoke checks failed (passed={passed})"


if __name__ == "__main__":
    if failed:
        sys.exit(1)
    print("All tests passed!")
