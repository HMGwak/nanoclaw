from __future__ import annotations

import importlib
import json
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

for _mod_name in ("openai", "pydantic", "mlx_lm", "mlx_lm.sample_utils"):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)

_pydantic_stub = sys.modules["pydantic"]


class _StubBaseModel:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

    def model_dump(self):
        return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}


setattr(_pydantic_stub, "BaseModel", _StubBaseModel)
setattr(_pydantic_stub, "ValidationError", type("ValidationError", (Exception,), {}))

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


run_wiki_mod = importlib.import_module("catalog.tasks.wiki.run_wiki")
load_domain_assets = run_wiki_mod.load_domain_assets
build_layer_context = run_wiki_mod.build_layer_context
resolve_base_path = run_wiki_mod.resolve_base_path

engine_mod = importlib.import_module("engine")
build_evaluation_from_spec = engine_mod.build_evaluation_from_spec

print("=== load_domain_assets / build_layer_context ===")

spec = _make_spec_json(
    {
        "domain": "tobacco_regulation",
        "version": "v1",
        "structure": {
            "title": "root",
            "sections": {
                "a": {"title": "규제 환경 요약", "level": 1, "sections": {}},
                "b": {"title": "첨가물정보제출", "level": 1, "sections": {}},
            },
        },
        "shared_prompt_rules": {
            "extract": "SHARED EXTRACT RULES",
            "compose": "SHARED COMPOSE RULES",
        },
        "runner": {},
        "layers": {
            "layer1": {
                "source": {"view": "Tobacco Law"},
                "prompt": {
                    "extract": {"version": "v1", "prompt": "L1 EXTRACT"},
                    "compose": {
                        "version": "v1",
                        "prompt": "L1 COMPOSE {structure_block}",
                    },
                },
                "evaluation": {
                    "version": "v1",
                    "loop": {"max_iterations": 5},
                    "scoring": {"items": []},
                },
            },
            "layer2": {
                "source": {"view": "Law Reviews"},
                "prompt": {
                    "extract": {"version": "v1", "prompt": "L2 EXTRACT"},
                    "update": {"version": "v1", "prompt": "L2 UPDATE"},
                    "revise": {"version": "v1", "prompt": "L2 REVISE"},
                },
                "evaluation": {
                    "version": "v1",
                    "loop": {"max_iterations": 2},
                    "scoring": {"items": []},
                },
            },
            "layer3": {
                "source": {"view": "첨가물 제출"},
                "prompt": {
                    "extract": {"version": "v1", "prompt": "L3 EXTRACT"},
                    "update": {"version": "v1", "prompt": "L3 UPDATE"},
                    "revise": {"version": "v1", "prompt": "L3 REVISE"},
                },
                "evaluation": {
                    "version": "v1",
                    "loop": {"max_iterations": 4},
                    "scoring": {"items": []},
                },
            },
        },
    }
)

assets = load_domain_assets(spec, "tobacco_regulation")
record_check(
    "layers discovered",
    assets["layers"] == ["layer1", "layer2", "layer3"],
    str(assets["layers"]),
)
record_check("doc_structure built", len(assets.get("doc_structure") or []) == 2)
record_check(
    "shared prompt rules loaded",
    assets["shared_prompt_rules"]["extract"] == "SHARED EXTRACT RULES",
)

vault_root = Path.home() / "Documents" / "Mywork"
wiki_output_dir = (
    vault_root / "3. Resource/LLM Knowledge Base/wiki" / "tobacco_regulation"
)

ctx1 = build_layer_context(
    domain="tobacco_regulation",
    layer="layer1",
    vault_root=vault_root,
    wiki_output_dir=wiki_output_dir,
    spec_path=spec,
    filter_expr='(country="Taiwan _China")',
    max_docs=3,
    domain_assets=assets,
)
record_check("layer1 view from spec", ctx1["view"] == "Tobacco Law")
record_check(
    "layer1 extract has shared rules",
    ctx1["spec_extract_prompt"].startswith("SHARED EXTRACT RULES"),
)
record_check(
    "layer1 compose has shared rules",
    ctx1["spec_compose_prompt"].startswith("SHARED COMPOSE RULES"),
)
record_check(
    "layer1 base path resolved",
    resolve_base_path("tobacco_regulation", vault_root).name
    == "tobacco_regulation.base",
)

ctx2 = build_layer_context(
    domain="tobacco_regulation",
    layer="layer2",
    vault_root=vault_root,
    wiki_output_dir=wiki_output_dir,
    spec_path=spec,
    filter_expr=None,
    max_docs=None,
    domain_assets=assets,
)
record_check("layer2 view from spec", ctx2["view"] == "Law Reviews")
record_check(
    "layer2 update has shared compose rules",
    ctx2["spec_update_prompt"].startswith("SHARED COMPOSE RULES"),
)

rubric = build_evaluation_from_spec(
    ctx2["_parsed_evaluation_override"].config.model_dump()
    if False
    else {"loop": {"max_iterations": 2}, "scoring": {"items": []}}
)
record_check("build_evaluation_from_spec callable", rubric.config.max_iterations == 2)

spec.unlink()

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
    real_assets = load_domain_assets(real_path, "tobacco_regulation")
    record_check(
        "real JSON has 3 layers",
        real_assets["layers"] == ["layer1", "layer2", "layer3"],
        str(real_assets["layers"]),
    )
    record_check(
        "real JSON has doc_structure", len(real_assets.get("doc_structure") or []) > 0
    )
else:
    print("  SKIP  real JSON not found")

print(f"\n{'=' * 50}")
print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")


def test_spec_wiring_smoke() -> None:
    assert failed == 0, f"{failed} smoke checks failed (passed={passed})"


if __name__ == "__main__":
    if failed:
        sys.exit(1)
    print("All tests passed!")
