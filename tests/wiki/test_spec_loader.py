"""Tests for SpecLoader — valid load, malformed JSONL, no-match fallback.

Run:
    .venv/bin/python3 tests/wiki/test_spec_loader.py
"""

from __future__ import annotations

import importlib
import sys
import tempfile
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent.parent
_src = _project_root / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

_loader = importlib.import_module("catalog.loaders.spec_loader")
SpecLoader = _loader.SpecLoader
SpecValidationError = _loader.SpecValidationError

passed = 0
failed = 0


def test(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


# ── Helpers ────────────────────────────────────────────────────────


def _make_jsonl(lines: list[str]) -> Path:
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, encoding="utf-8"
    )
    for line in lines:
        tmp.write(line + "\n")
    tmp.close()
    return Path(tmp.name)


def _valid_entries() -> list[str]:
    return [
        '{"domain":"regulation","version":"v1","tree":{"structure":{}}}',
        '{"type":"layer1.prompt.extract","domain":"regulation","layer":"layer1","version":"v1","prompt":"extract prompt here","claim_schema":{},"extraction_rules":{}}',
        '{"type":"layer1.prompt.compose","domain":"regulation","layer":"layer1","version":"v1","prompt":"compose prompt here","template_variables":["structure_block"],"format_rules":{}}',
        '{"type":"layer2.prompt.update","domain":"regulation","layer":"layer2","version":"v1","prompt":"update prompt here","format_rules":{}}',
        '{"type":"layer2.prompt.revise","domain":"regulation","layer":"layer2","version":"v1","prompt":"revise prompt here"}',
        '{"type":"layer1.evaluation","domain":"regulation","layer":"layer1","version":"v1","loop":{"max_iterations":3},"scoring":{"items":[]}}',
    ]


# ══════════════════════════════════════════════════════════════════
# 1. Valid load
# ══════════════════════════════════════════════════════════════════
print("\n=== Valid Load ===")

path = _make_jsonl(_valid_entries())
loader = SpecLoader(spec_path=path)

all_specs = loader.load_specs("regulation", "layer1")
test(
    "load_specs returns 3 entries (excl structure)",
    len(all_specs) == 3,
    f"got {len(all_specs)}",
)
test("has extract", "layer1.prompt.extract" in all_specs)
test("has compose", "layer1.prompt.compose" in all_specs)
test("has evaluation", "layer1.evaluation" in all_specs)

extract = loader.load_extract_prompt("regulation", "layer1")
test("extract prompt returned", extract == "extract prompt here", f"got {extract!r}")

compose = loader.load_compose_prompt("regulation", "layer1")
test("compose prompt returned", compose == "compose prompt here", f"got {compose!r}")

evaluation = loader.load_evaluation("regulation", "layer1")
test("evaluation returned", evaluation is not None)
test(
    "evaluation has loop config",
    evaluation is not None and "loop" in evaluation,
    f"keys: {list(evaluation.keys()) if evaluation else 'None'}",
)

# ── Structure is indexed under empty layer ─────────────────────────
structure_specs = loader.load_specs("regulation", "")
test("structure found under empty layer", "structure" in structure_specs)

update_prompt = loader.load_update_prompt("regulation", "layer2")
test(
    "layer2 update prompt returned",
    update_prompt == "update prompt here",
    f"got {update_prompt!r}",
)

revise_prompt = loader.load_revise_prompt("regulation", "layer2")
test(
    "layer2 revise prompt returned",
    revise_prompt == "revise prompt here",
    f"got {revise_prompt!r}",
)

# ── Lazy reload does not re-parse ──────────────────────────────────
entries_before = loader._entries
all_specs_2 = loader.load_specs("regulation", "layer1")
test("lazy cache works (entries unchanged)", loader._entries is entries_before)

path.unlink()

# ══════════════════════════════════════════════════════════════════
# 2. Malformed JSONL
# ══════════════════════════════════════════════════════════════════
print("\n=== Malformed JSONL ===")

# 2a. Bad JSON
p_bad_json = _make_jsonl(["not-json-at-all"])
try:
    SpecLoader(spec_path=p_bad_json).load_specs("x", "y")
    test("malformed JSON raises", False, "no exception raised")
except SpecValidationError as e:
    test("malformed JSON raises SpecValidationError", "malformed JSON" in str(e))
    test("error includes line number", "Line 1" in str(e))
p_bad_json.unlink()

# 2b. JSON array instead of object
p_array = _make_jsonl(["[1,2,3]"])
try:
    SpecLoader(spec_path=p_array).load_specs("x", "y")
    test("JSON array raises", False, "no exception raised")
except SpecValidationError as e:
    test("JSON array raises SpecValidationError", "expected a JSON object" in str(e))
p_array.unlink()

# 2c. Missing 'type' field
p_no_type = _make_jsonl(['{"domain":"x","version":"v1"}'])
try:
    SpecLoader(spec_path=p_no_type).load_specs("x", "y")
    test("missing type raises", False, "no exception raised")
except SpecValidationError as e:
    test("missing type raises SpecValidationError", "missing 'type'" in str(e))
p_no_type.unlink()

# 2d. Missing required field on non-structure entry
p_no_domain = _make_jsonl(
    ['{"type":"layer1.prompt.extract","layer":"layer1","version":"v1","prompt":"x"}']
)
try:
    SpecLoader(spec_path=p_no_domain).load_specs("x", "y")
    test("missing domain raises", False, "no exception raised")
except SpecValidationError as e:
    test(
        "missing domain raises SpecValidationError",
        "missing required field 'domain'" in str(e),
    )
p_no_domain.unlink()

# 2e. Unsupported version
p_bad_ver = _make_jsonl(
    [
        '{"type":"layer1.prompt.extract","domain":"x","layer":"layer1","version":"1.0","prompt":"x"}'
    ]
)
try:
    SpecLoader(spec_path=p_bad_ver).load_specs("x", "y")
    test("bad version raises", False, "no exception raised")
except SpecValidationError as e:
    test("bad version raises SpecValidationError", "does not match" in str(e))
p_bad_ver.unlink()

# 2f. Unsupported type
p_bad_type = _make_jsonl(
    ['{"type":"future.type","domain":"x","layer":"layer1","version":"v1"}']
)
try:
    SpecLoader(spec_path=p_bad_type).load_specs("x", "y")
    test("unsupported type raises", False, "no exception raised")
except SpecValidationError as e:
    test(
        "unsupported type raises SpecValidationError", "unsupported spec type" in str(e)
    )
p_bad_type.unlink()

# 2g. Duplicate entry
p_dup = _make_jsonl(
    [
        '{"type":"layer1.prompt.extract","domain":"x","layer":"layer1","version":"v1","prompt":"a"}',
        '{"type":"layer1.prompt.extract","domain":"x","layer":"layer1","version":"v1","prompt":"b"}',
    ]
)
try:
    SpecLoader(spec_path=p_dup).load_specs("x", "y")
    test("duplicate raises", False, "no exception raised")
except SpecValidationError as e:
    test("duplicate raises SpecValidationError", "duplicate entry" in str(e))
p_dup.unlink()

# 2h. Structure missing domain
p_struct_no_dom = _make_jsonl(['{"type":"structure","version":"v1","tree":{}}'])
try:
    SpecLoader(spec_path=p_struct_no_dom).load_specs("x", "y")
    test("structure missing domain raises", False, "no exception raised")
except SpecValidationError as e:
    test("structure missing domain raises", "structure entry missing" in str(e))
p_struct_no_dom.unlink()

# 2i. Non-existent file
try:
    SpecLoader(spec_path=Path("/tmp/does_not_exist_abc123.jsonl")).load_specs("x", "y")
    test("non-existent file raises", False, "no exception raised")
except SpecValidationError as e:
    test("non-existent file raises SpecValidationError", "not found" in str(e))

# ══════════════════════════════════════════════════════════════════
# 3. No-match fallback
# ══════════════════════════════════════════════════════════════════
print("\n=== No-Match Fallback ===")

p = _make_jsonl(_valid_entries())
loader = SpecLoader(spec_path=p)

no_match_specs = loader.load_specs("nonexistent", "layer1")
test("no-match load_specs returns empty dict", no_match_specs == {})

no_extract = loader.load_extract_prompt("nonexistent", "layer1")
test("no-match extract returns None", no_extract is None)

no_compose = loader.load_compose_prompt("nonexistent", "layer1")
test("no-match compose returns None", no_compose is None)

no_eval = loader.load_evaluation("nonexistent", "layer1")
test("no-match evaluation returns None", no_eval is None)

p.unlink()

# ══════════════════════════════════════════════════════════════════
# 4. ENV VAR discovery
# ══════════════════════════════════════════════════════════════════
print("\n=== ENV VAR Discovery ===")

import os

p_env = _make_jsonl(_valid_entries())
os.environ["SPEC_PATH"] = str(p_env)
try:
    loader_env = SpecLoader()
    specs = loader_env.load_specs("regulation", "layer1")
    test("SPEC_PATH env picks up file", len(specs) == 3)
finally:
    del os.environ["SPEC_PATH"]
p_env.unlink()

# SPEC_PATH pointing to non-existent file (lazy — raises on load, not init)
os.environ["SPEC_PATH"] = "/tmp/no_such_file_abc.jsonl"
try:
    bad_loader = SpecLoader()
    bad_loader.load_specs("x", "y")
    test("bad SPEC_PATH raises", False, "no exception")
except SpecValidationError as e:
    test(
        "bad SPEC_PATH raises on load",
        "not found" in str(e) or "non-existent" in str(e),
    )
finally:
    del os.environ["SPEC_PATH"]

# ══════════════════════════════════════════════════════════════════
# 5. Path-aware load_specs (3-arg plan contract)
# ══════════════════════════════════════════════════════════════════
print("\n=== Path-Aware load_specs ===")

p_path_aware = _make_jsonl(_valid_entries())
sl = SpecLoader()
specs_3arg = sl.load_specs(p_path_aware, "regulation", "layer1")
test("3-arg returns 3 entries", len(specs_3arg) == 3, f"got {len(specs_3arg)}")
test("3-arg has extract", "layer1.prompt.extract" in specs_3arg)
test("3-arg has compose", "layer1.prompt.compose" in specs_3arg)
test("3-arg has evaluation", "layer1.evaluation" in specs_3arg)

# 3-arg with string path
specs_str = sl.load_specs(str(p_path_aware), "regulation", "layer1")
test("3-arg string path works", len(specs_str) == 3)

# 3-arg with non-existent file
try:
    sl.load_specs("/tmp/does_not_exist_xyz.jsonl", "x", "y")
    test("3-arg bad path raises", False, "no exception")
except SpecValidationError as e:
    test("3-arg bad path raises", "not found" in str(e))

# 3-arg no-match
specs_no = sl.load_specs(p_path_aware, "nonexistent", "layer1")
test("3-arg no-match returns empty", specs_no == {})

# 3-arg with malformed JSONL
p_mal = _make_jsonl(["bad-json"])
try:
    sl.load_specs(p_mal, "x", "y")
    test("3-arg malformed raises", False, "no exception")
except SpecValidationError:
    test("3-arg malformed raises SpecValidationError", True)
p_mal.unlink()

p_path_aware.unlink()

# ══════════════════════════════════════════════════════════════════
# 6. Real JSONL integration (if available)
# ══════════════════════════════════════════════════════════════════
print("\n=== Real JSONL Integration ===")

real_path = (
    Path.home()
    / "Projects/nextboat-information"
    / "desktop/tauri-app/src/features/information/specs/domainSpecs.jsonl"
)
if real_path.is_file():
    real_loader = SpecLoader(spec_path=real_path)
    real_specs = real_loader.load_specs("regulation", "layer1")
    test("real JSONL loads", len(real_specs) >= 3, f"got {len(real_specs)} entries")
    test("real JSONL has extract", "layer1.prompt.extract" in real_specs)
    test("real JSONL has compose", "layer1.prompt.compose" in real_specs)
    test("real JSONL has evaluation", "layer1.evaluation" in real_specs)

    real_extract = real_loader.load_extract_prompt("regulation", "layer1")
    test(
        "real extract prompt is non-empty",
        real_extract is not None and len(real_extract) > 100,
    )

    real_compose = real_loader.load_compose_prompt("regulation", "layer1")
    test(
        "real compose prompt is non-empty",
        real_compose is not None and len(real_compose) > 100,
    )

    real_eval = real_loader.load_evaluation("regulation", "layer1")
    test(
        "real evaluation has loop config", real_eval is not None and "loop" in real_eval
    )
    test(
        "real evaluation has scoring", real_eval is not None and "scoring" in real_eval
    )
else:
    print("  SKIP  real JSONL not found at expected path")

# ── Summary ────────────────────────────────────────────────────────
print(f"\n{'=' * 50}")
print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
if failed:
    sys.exit(1)
else:
    print("All tests passed!")
