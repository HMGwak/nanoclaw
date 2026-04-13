"""Tests for spec wiring: spec-driven Layer 1 pipeline.

Run:
    cd /Users/planee/Automation/nanoclaw
    .venv/bin/python3 tests/wiki/test_spec_wiring.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import types
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent.parent
_src = _project_root / "src"
_karpathy = _project_root / "src" / "catalog" / "methods" / "karpathy-loop"
_wiki = _project_root / "src" / "catalog" / "tasks" / "wiki"

for p in (str(_src), str(_karpathy), str(_wiki)):
    if p not in sys.path:
        sys.path.insert(0, p)

# Pre-empt heavy optional deps that may not be installed.
# openai, pydantic, mlx_lm are not needed for wiring tests.
# Provide enough stub surface for import chains that reach them.
for _mod_name in ("openai", "pydantic", "mlx_lm", "mlx_lm.sample_utils"):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)

# pydantic stubs needed by agents.py and loop_types consumers
_pydantic_stub = sys.modules["pydantic"]


class _StubBaseModel:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

    def model_dump(self):
        return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}


setattr(_pydantic_stub, "BaseModel", _StubBaseModel)
setattr(_pydantic_stub, "ValidationError", type("ValidationError", (Exception,), {}))

# openai stubs needed by agents.py
_openai_stub = sys.modules["openai"]
setattr(
    _openai_stub, "OpenAI", type("OpenAI", (), {"__init__": lambda self, **kw: None})
)
setattr(_openai_stub, "RateLimitError", type("RateLimitError", (Exception,), {}))
setattr(
    _openai_stub, "InternalServerError", type("InternalServerError", (Exception,), {})
)
setattr(
    _openai_stub, "AuthenticationError", type("AuthenticationError", (Exception,), {})
)
setattr(
    _openai_stub,
    "PermissionDeniedError",
    type("PermissionDeniedError", (Exception,), {}),
)

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


def _make_jsonl(entries: list[dict]) -> Path:
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, encoding="utf-8"
    )
    for entry in entries:
        tmp.write(json.dumps(entry, ensure_ascii=False) + "\n")
    tmp.close()
    return Path(tmp.name)


_QUANT_MEASURE = (
    "def measure(output_files, reference_files):\n"
    "    return {'value': 0.5, 'detail': 'test'}\n"
)


# ══════════════════════════════════════════════════════════════════
# 1. Runner helper: _load_all_specs
# ══════════════════════════════════════════════════════════════════
print("=== _load_all_specs ===")

sys.path.insert(0, str(_project_root / "scripts"))
import run_country_layer1 as _run_script  # type: ignore[import-not-found]
import run_country_wiki as _run_country_wiki  # type: ignore[import-not-found]

load_all_specs = _run_script._load_all_specs
tree_to_headings = _run_script._tree_to_headings

# -- 1a. Full spec with all entries
spec_full = _make_jsonl(
    [
        {
            "domain": "regulation",
            "version": "v1",
            "tree": {
                "structure": {
                    "title": "root",
                    "sections": {
                        "a": {"title": "규제 환경 요약", "level": 1, "sections": {}},
                        "b": {
                            "title": "첨가물정보제출",
                            "level": 1,
                            "sections": {
                                "b1": {"title": "신규제출", "level": 2, "sections": {}},
                            },
                        },
                    },
                }
            },
        },
        {
            "type": "layer1.prompt.extract",
            "domain": "regulation",
            "layer": "layer1",
            "version": "v1",
            "prompt": "EXTRACT OVERRIDE",
        },
        {
            "type": "layer1.prompt.compose",
            "domain": "regulation",
            "layer": "layer1",
            "version": "v1",
            "prompt": "COMPOSE OVERRIDE with {structure_block}",
        },
        {
            "type": "layer1.evaluation",
            "domain": "regulation",
            "layer": "layer1",
            "version": "v1",
            "loop": {"max_iterations": 5, "keep_threshold": 90},
            "scoring": {"items": []},
        },
        {
            "type": "layer2.prompt.update",
            "domain": "regulation",
            "layer": "layer2",
            "version": "v1",
            "prompt": "L2 UPDATE",
            "format_rules": {},
        },
        {
            "type": "layer2.prompt.revise",
            "domain": "regulation",
            "layer": "layer2",
            "version": "v1",
            "prompt": "L2 REVISE",
        },
        {
            "type": "layer2.evaluation",
            "domain": "regulation",
            "layer": "layer2",
            "version": "v1",
            "loop": {"max_iterations": 2, "keep_threshold": 88},
            "scoring": {"items": []},
        },
        {
            "type": "layer3.prompt.update",
            "domain": "regulation",
            "layer": "layer3",
            "version": "v1",
            "prompt": "L3 UPDATE",
            "format_rules": {},
        },
        {
            "type": "layer3.prompt.revise",
            "domain": "regulation",
            "layer": "layer3",
            "version": "v1",
            "prompt": "L3 REVISE",
        },
        {
            "type": "layer3.evaluation",
            "domain": "regulation",
            "layer": "layer3",
            "version": "v1",
            "loop": {"max_iterations": 4, "keep_threshold": 87},
            "scoring": {"items": []},
        },
    ]
)
spec_data_full = load_all_specs(spec_full, "regulation", "layer1")
test("full spec has extract", "spec_extract_prompt" in spec_data_full)
test(
    "full spec extract value",
    spec_data_full["spec_extract_prompt"] == "EXTRACT OVERRIDE",
)
test("full spec has compose", "spec_compose_prompt" in spec_data_full)
test("full spec has eval", "spec_eval_config" in spec_data_full)
test("full spec has doc_structure", "doc_structure" in spec_data_full)
test("full spec doc_structure has headings", len(spec_data_full["doc_structure"]) >= 2)
test(
    "full spec eval loop.max_iterations",
    spec_data_full["spec_eval_config"]["loop"]["max_iterations"] == 5,
)

spec_data_l2 = _run_country_wiki._load_all_specs(spec_full, "regulation", "layer2")
test("layer2 has update prompt", spec_data_l2.get("spec_update_prompt") == "L2 UPDATE")
test("layer2 has revise prompt", spec_data_l2.get("spec_revise_prompt") == "L2 REVISE")
test(
    "layer2 has eval",
    spec_data_l2.get("spec_eval_config", {}).get("loop", {}).get("max_iterations") == 2,
)

spec_data_l3 = _run_country_wiki._load_all_specs(spec_full, "regulation", "layer3")
test("layer3 has update prompt", spec_data_l3.get("spec_update_prompt") == "L3 UPDATE")
test("layer3 has revise prompt", spec_data_l3.get("spec_revise_prompt") == "L3 REVISE")
test(
    "layer3 has eval",
    spec_data_l3.get("spec_eval_config", {}).get("loop", {}).get("max_iterations") == 4,
)

test(
    "run_country_wiki has prompt surface version",
    hasattr(_run_country_wiki, "PROMPT_SURFACE_VERSION"),
)
test(
    "run_country_wiki prompt surface version looks semantic",
    getattr(_run_country_wiki, "PROMPT_SURFACE_VERSION", "").startswith("v"),
)
spec_full.unlink()

# -- 1b. Partial spec (only extract)
spec_partial = _make_jsonl(
    [
        {
            "domain": "regulation",
            "version": "v1",
            "tree": {"structure": {"title": "root", "sections": {}}},
        },
        {
            "type": "layer1.prompt.extract",
            "domain": "regulation",
            "layer": "layer1",
            "version": "v1",
            "prompt": "ONLY EXTRACT",
        },
    ]
)
spec_data_partial = load_all_specs(spec_partial, "regulation", "layer1")
test("partial has extract", "spec_extract_prompt" in spec_data_partial)
test("partial no compose", "spec_compose_prompt" not in spec_data_partial)
test("partial no eval", "spec_eval_config" not in spec_data_partial)
spec_partial.unlink()

# -- 1c. Wrong domain → empty overrides (no extract/compose/eval)
spec_wrong = _make_jsonl(
    [
        {
            "type": "layer1.prompt.extract",
            "domain": "other_domain",
            "layer": "layer1",
            "version": "v1",
            "prompt": "WRONG DOMAIN",
        },
    ]
)
spec_data_wrong = load_all_specs(spec_wrong, "regulation", "layer1")
test("wrong domain no extract", "spec_extract_prompt" not in spec_data_wrong)
spec_wrong.unlink()


# ══════════════════════════════════════════════════════════════════
# 2. _tree_to_headings
# ══════════════════════════════════════════════════════════════════
print("\n=== _tree_to_headings ===")

headings = tree_to_headings(
    {
        "structure": {
            "title": "root",
            "sections": {
                "a": {"title": "규제 환경 요약", "level": 1, "sections": {}},
                "b": {
                    "title": "첨가물정보제출",
                    "level": 1,
                    "sections": {
                        "b1": {
                            "title": "신규제출",
                            "level": 2,
                            "sections": {
                                "b1a": {
                                    "title": "제출 시기",
                                    "level": 3,
                                    "sections": {},
                                },
                            },
                        },
                    },
                },
            },
        }
    }
)
test("headings count", len(headings) == 4, f"got {len(headings)}")
test("heading level 1", headings[0] == "## 규제 환경 요약")
test("heading level 1 second", headings[1] == "## 첨가물정보제출")
test("heading level 2", headings[2] == "### 신규제출")
test("heading level 3", headings[3] == "#### 제출 시기")

empty_headings = tree_to_headings({"structure": {"title": "root", "sections": {}}})
test("empty tree no headings", len(empty_headings) == 0)


# ══════════════════════════════════════════════════════════════════
# 3. ChunkedSynthesizer extract/compose override
# ══════════════════════════════════════════════════════════════════
print("\n=== ChunkedSynthesizer override wiring ===")

import importlib

synth_mod = importlib.import_module("catalog.tasks.wiki.synthesizer")
ChunkedSynthesizer = synth_mod.ChunkedSynthesizer


class _MockAgent:
    def __init__(self):
        self.model = "test"

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        return "# Test wiki\n\ntest content [^1]\n\n[^1]: [[test]]"


synth_default = ChunkedSynthesizer(_MockAgent())
test("default extract override is None", synth_default._extract_prompt_override is None)
test("default compose override is None", synth_default._compose_prompt_override is None)

synth_extract = ChunkedSynthesizer(
    _MockAgent(), extract_prompt_override="CUSTOM EXTRACT"
)
test(
    "extract override stored",
    synth_extract._extract_prompt_override == "CUSTOM EXTRACT",
)

synth_compose = ChunkedSynthesizer(
    _MockAgent(), compose_prompt_override="CUSTOM COMPOSE {structure_block}"
)
test(
    "compose override stored",
    synth_compose._compose_prompt_override == "CUSTOM COMPOSE {structure_block}",
)


# ══════════════════════════════════════════════════════════════════
# 4. build_evaluation_from_spec
# ══════════════════════════════════════════════════════════════════
print("\n=== build_evaluation_from_spec ===")

engine_mod = importlib.import_module("engine")
build_evaluation_from_spec = engine_mod.build_evaluation_from_spec
RubricItem = engine_mod.RubricItem
RunResult = engine_mod.RunResult

# -- 4a. Full eval config with quantitative and qualitative items
eval_full = {
    "loop": {
        "max_iterations": 3,
        "keep_threshold": 85,
        "discard_threshold": 55,
        "convergence_delta": 3,
    },
    "scoring": {
        "items": [
            {
                "id": "citation_ratio",
                "name": "Citation Ratio",
                "item_type": "quantitative",
                "max_score": 15,
                "description": "Citation ratio",
                "hard_gate": 0.7,
                "measure_source": _QUANT_MEASURE,
            },
            {
                "id": "coverage",
                "name": "Coverage",
                "item_type": "qualitative",
                "max_score": 30,
                "description": "Coverage desc",
                "anchors": "| Score band | Anchor |",
            },
        ],
    },
}
rubric = build_evaluation_from_spec(eval_full)
test("rubric config max_iterations", rubric.config.max_iterations == 3)
test("rubric config keep_threshold", rubric.config.keep_threshold == 85.0)
test("rubric config discard_threshold", rubric.config.discard_threshold == 55.0)
test("rubric items count", len(rubric.items) == 2)
test("rubric item 0 name", rubric.items[0].name == "Citation Ratio")
test("rubric item 0 type", rubric.items[0].item_type == "quantitative")
test("rubric item 0 max_score", rubric.items[0].max_score == 15.0)
test("rubric item 0 hard_gate", rubric.items[0].hard_gate == 0.7)
test("rubric item 0 has measure_fn", rubric.items[0].measure_fn is not None)
test("rubric item 1 type", rubric.items[1].item_type == "qualitative")
test("rubric item 1 anchors", rubric.items[1].anchors == "| Score band | Anchor |")
test("rubric item 1 no measure_fn", rubric.items[1].measure_fn is None)

# -- 4b. Measure function actually works
result = rubric.items[0].measure_fn([], [])
test("measure returns value", result["value"] == 0.5)

# -- 4c. Partial loop config keeps defaults
eval_partial = {
    "loop": {"max_iterations": 7},
    "scoring": {"items": []},
}
rubric_partial = build_evaluation_from_spec(eval_partial)
test("partial max_iterations", rubric_partial.config.max_iterations == 7)
test(
    "partial keeps default keep_threshold", rubric_partial.config.keep_threshold == 85.0
)

# -- 4d. Empty eval config
eval_empty = {"scoring": {"items": []}}
rubric_empty = build_evaluation_from_spec(eval_empty)
test("empty eval default max_iterations", rubric_empty.config.max_iterations == 3)
test("empty eval zero items", len(rubric_empty.items) == 0)


# ══════════════════════════════════════════════════════════════════
# 5. run_loop accepts _parsed_evaluation_override (no rubric_path needed)
# ══════════════════════════════════════════════════════════════════
print("\n=== run_loop with _parsed_evaluation_override ===")

import shutil
import tempfile as _tf

run_loop = engine_mod.run_loop

_eval_for_loop = {
    "loop": {"max_iterations": 1, "keep_threshold": 0},
    "scoring": {
        "items": [
            {
                "id": "test_quant",
                "name": "Test Quant",
                "item_type": "quantitative",
                "max_score": 100,
                "description": "Test",
                "hard_gate": None,
                "measure_source": "def measure(output_files, reference_files):\n    return {'value': 1.0, 'detail': 'perfect'}\n",
            },
        ]
    },
}
_rubric_for_loop = build_evaluation_from_spec(_eval_for_loop)
_rubric_for_loop.extra_config["doc_structure"] = ["## Test Section"]


class _MockEvaluator:
    """Stub evaluator that returns perfect scores without LLM calls."""

    class _MockAgents:
        def generate(self, system_prompt: str, user_prompt: str) -> str:
            return "# Test wiki\n\ntest [^1]\n\n[^1]: [[test]]"

        def evaluate(self, system_prompt: str, content: str, rubric_items: list[dict]):
            ItemScore = engine_mod.ItemScore
            scores = {}
            for item in rubric_items:
                scores[item["name"]] = ItemScore(
                    score=item["max_score"],
                    rationale="mock",
                    improvements=[],
                )
            return engine_mod.EvalResult(scores=scores, raw_response="mock")

    def __init__(self):
        self.agents = self._MockAgents()

    def run(self, *args, **kwargs):
        context = kwargs.get("context")
        if context is None and len(args) >= 3:
            context = args[2]
        output_dir = getattr(context, "output_dir", None)
        if output_dir is None:
            output_dir = Path(tempfile.mkdtemp())
        out = output_dir / "mock.md"
        out.write_text("# Test wiki\n\ntest [^1]\n\n[^1]: [[test]]")
        return RunResult(output_files=[out])

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        return "# Test wiki\n\ntest [^1]\n\n[^1]: [[test]]"


_loop_output = Path(_tf.mkdtemp())

report = run_loop(
    task=_MockEvaluator(),
    rubric_path=None,
    input_files=[],
    reference_files=[],
    agents=_MockEvaluator._MockAgents(),
    output_dir=_loop_output,
    context_config={
        "_parsed_evaluation_override": _rubric_for_loop,
        "country": "test",
        "layer": "tobacco_law",
        "base_path": "/tmp/nonexistent",
        "vault_root": "/tmp/nonexistent",
    },
)
test("run_loop with override returns report", report is not None)
test("run_loop report has status", report.status in ("keep", "error", "discard"))
test("run_loop report has run_id", len(report.run_id) > 0)

shutil.rmtree(_loop_output, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════
# 6. Real JSONL integration
# ══════════════════════════════════════════════════════════════════
print("\n=== Real JSONL integration ===")

real_path = (
    Path.home()
    / "Projects/nextboat-information"
    / "desktop/tauri-app/src/features/information/specs/domainSpecs.jsonl"
)
if real_path.is_file():
    real_data = load_all_specs(real_path, "regulation", "layer1")
    test("real has extract", "spec_extract_prompt" in real_data)
    test("real has compose", "spec_compose_prompt" in real_data)
    test("real has eval", "spec_eval_config" in real_data)
    test("real has doc_structure", "doc_structure" in real_data)
    test(
        "real extract > 100 chars",
        len(real_data.get("spec_extract_prompt", "")) > 100,
    )
    test(
        "real compose has {structure_block}",
        "{structure_block}" in real_data.get("spec_compose_prompt", ""),
    )
    real_eval = real_data.get("spec_eval_config", {})
    test(
        "real eval loop.max_iterations is 3",
        real_eval.get("loop", {}).get("max_iterations") == 3,
    )
    test(
        "real eval has scoring items",
        len(real_eval.get("scoring", {}).get("items", [])) == 6,
    )

    real_rubric = build_evaluation_from_spec(real_eval)
    test("real rubric has 6 items", len(real_rubric.items) == 6)
    test(
        "real rubric has Citation Ratio",
        any(it.name == "Citation Ratio" for it in real_rubric.items),
    )
    test(
        "real rubric quant items have measure_fn",
        all(
            it.measure_fn is not None
            for it in real_rubric.items
            if it.item_type == "quantitative"
        ),
    )
    test(
        "real rubric qual items have anchors",
        all(
            it.anchors is not None and len(it.anchors) > 0
            for it in real_rubric.items
            if it.item_type == "qualitative"
        ),
    )
    test(
        "real rubric config max_iterations is 3", real_rubric.config.max_iterations == 3
    )
    test(
        "real rubric config keep_threshold is 85",
        real_rubric.config.keep_threshold == 85.0,
    )

    real_headings = real_data.get("doc_structure", [])
    test("real doc_structure has headings", len(real_headings) > 0)
    test(
        "real doc_structure has 담배 원료", any("담배 원료" in h for h in real_headings)
    )
    test(
        "real doc_structure NOT has 공통 요건 (old structure)",
        not any("공통 요건" in h for h in real_headings),
    )
    test(
        "real doc_structure NOT has 궐련 (old structure)",
        not any("궐련" in h for h in real_headings),
    )

    version_check = subprocess.run(
        ["python3", "scripts/check_domain_spec_versions.py"],
        cwd=Path.home() / "Projects/nextboat-information",
        capture_output=True,
        text=True,
    )
    test(
        "version governance script passes",
        version_check.returncode == 0,
        version_check.stdout + version_check.stderr,
    )
else:
    print("  SKIP  real JSONL not found")


# ── Summary ────────────────────────────────────────────────────────
print(f"\n{'=' * 50}")
print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
if failed:
    sys.exit(1)
else:
    print("All tests passed!")
