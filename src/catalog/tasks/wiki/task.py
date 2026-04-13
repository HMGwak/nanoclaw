"""WikiTask - wiki generation/revision with own generalist agent.

This task is independent of the quality-loop engine. It can run standalone
or be wrapped by the karpathy-loop for rubric-based iterative improvement.
When wrapped, the loop's reviewer agent evaluates; this task's generalist
agent generates and revises.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
import uuid
import fnmatch
from dataclasses import dataclass, field
from pathlib import Path

import openai
from pydantic import BaseModel
from typing import Literal

try:
    from .base_index import BaseIndexParser
    from .synthesizer import ChunkedSynthesizer
    from .wiki_tracker import WikiTracker
    from .json_utils import (
        extract_json,
        parse_validated,
        parse_validated_list,
        try_parse_validated,
    )
    from .markdown_utils import (
        MarkdownSectionEditor,
        SectionEdit,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
        strip_code_blocks,
        filter_attachment_footnotes,
        canonicalize_regulation_markdown,
        preserve_canonical_subtrees,
    )
except ImportError:
    from base_index import BaseIndexParser  # type: ignore[no-redef]
    from synthesizer import ChunkedSynthesizer  # type: ignore[no-redef]
    from wiki_tracker import WikiTracker  # type: ignore[no-redef]
    from json_utils import (
        extract_json,
        parse_validated,
        parse_validated_list,
        try_parse_validated,
    )  # type: ignore[no-redef]
    from markdown_utils import (
        MarkdownSectionEditor,
        SectionEdit,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
        strip_code_blocks,
        filter_attachment_footnotes,
        canonicalize_regulation_markdown,
        preserve_canonical_subtrees,
    )  # type: ignore[no-redef]


class WikiMatchDecision(BaseModel):
    action: Literal["create", "update"]
    target_wiki: str | None = None
    title: str


@dataclass
class RunResult:
    """Task run/revise return type (mirrors loop_types.RunResult)."""

    output_files: list[Path]
    metadata: dict = field(default_factory=dict)


try:
    from catalog.sdk_profiles.chatgpt_oauth import ChatGPTClient
except ImportError:
    try:
        import sys as _sys

        _sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
        from catalog.sdk_profiles.chatgpt_oauth import ChatGPTClient  # type: ignore[no-redef]
    except ImportError:
        ChatGPTClient = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

PROMPT_SURFACE_VERSION = "v2"

# Domain aliases used when deriving automatic filename filters.
# Example: "첨가물정보제출" domain docs are saved with "(규제준수)_..." filenames.
AUTO_FILTER_DOMAIN_ALIASES: dict[str, str] = {
    "첨가물정보제출": "규제준수",
}


# ── Local Gemma ──────────────────────────────────────────────────
GEMMA_SCRIPT = Path.home() / "Automation" / "local_llm_model" / "run_local_gemma.sh"
GEMMA_MODEL_DIR = Path.home() / "Automation" / "local_llm_model"
GEMMA_MODELS = {"gemma4-26b": "26b", "gemma4-e4b": "e4b", "qwen3.5-9b": "qwen"}
GEMMA_MODEL_PATHS = {
    "26b": GEMMA_MODEL_DIR / "gemma4-26b-a4b-it-4bit",
    "e4b": GEMMA_MODEL_DIR / "gemma4-e4b-it-8bit",
    "qwen": GEMMA_MODEL_DIR / "qwen3.5-9b-8bit",
}

# Cache loaded models to avoid reloading between calls
_loaded_models: dict[str, tuple] = {}


class LocalGemmaAgent:
    """Local LLM agent via mlx_lm Python API (no subprocess)."""

    def __init__(self, model: str = "gemma4-26b"):
        self.model_key = GEMMA_MODELS.get(model, "26b")
        self.model = model
        self._max_tokens = int(os.environ.get("GEMMA_MAX_TOKENS", "256"))

    def _get_model(self):
        """Load model and tokenizer (cached)."""
        if self.model_key not in _loaded_models:
            from mlx_lm import load

            model_path = str(GEMMA_MODEL_PATHS[self.model_key])
            logger.info("Loading local model: %s", model_path)
            model, tokenizer = load(model_path)
            _loaded_models[self.model_key] = (model, tokenizer)
        return _loaded_models[self.model_key]

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        from mlx_lm import generate as mlx_generate
        from mlx_lm.sample_utils import make_sampler

        model, tokenizer = self._get_model()

        # Use chat template if available
        if hasattr(tokenizer, "apply_chat_template"):
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
            prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        else:
            prompt = f"{system_prompt}\n\n{user_prompt}"

        sampler = make_sampler(temp=0.7, top_p=0.9)
        result = mlx_generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=self._max_tokens,
            sampler=sampler,
            verbose=False,
        )
        return result.strip()


# ── Agent ────────────────────────────────────────────────────────
class WikiAgent:
    """Generalist agent for wiki content generation.

    Auth priority: Local Gemma → ChatGPT OAuth → env-based openai SDK.
    All paths use the openai SDK; ChatGPTClient wraps OAuth token management.
    """

    def __init__(self, model: str | None = None):
        # Local Gemma models
        if model in GEMMA_MODELS:
            self._local = LocalGemmaAgent(model)
            self._use_local = True
            self.model = model
            return

        self._use_local = False
        backend = os.environ.get("NANOCLAW_AGENT_BACKEND", "")

        # ChatGPT OAuth (openai SDK + custom base_url)
        if (
            ChatGPTClient is not None
            and ChatGPTClient.AUTH_PATH.exists()
            and backend not in ("zai", "openai-compat", "opencode")
        ):
            self._chatgpt = ChatGPTClient(model=model or "gpt-5.4")
            self._use_chatgpt = True
            self.model = model or "gpt-5.4"
            return

        self._use_chatgpt = False

        # Env-based openai SDK fallback
        if backend in ("zai", "openai-compat"):
            api_key = os.environ.get("OPENAI_COMPAT_API_KEY", "")
            base_url = os.environ.get(
                "OPENAI_COMPAT_BASE_URL", "https://api.z.ai/api/paas/v4/"
            )
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "glm-5")
        else:
            api_key = os.environ.get("OPENAI_API_KEY", "") or os.environ.get(
                "OPENCODE_API_KEY", ""
            )
            base_url = os.environ.get("OPENAI_BASE_URL") or None
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "gpt-5.4")

        self.client = openai.OpenAI(api_key=api_key, base_url=base_url)
        self.model = model or default_model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        if self._use_local:
            return self._local.generate(system_prompt, user_prompt)
        if self._use_chatgpt:
            return self._chatgpt.generate(system_prompt, user_prompt)

        max_retries = 5
        for attempt in range(max_retries + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    max_tokens=8192,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                )
                return response.choices[0].message.content or ""
            except openai.RateLimitError:
                if attempt >= max_retries:
                    raise
                delay = min(2**attempt, 16)
                logger.warning(
                    "Rate limited, retry %d/%d after %ds",
                    attempt + 1,
                    max_retries,
                    delay,
                )
                time.sleep(delay)
            except openai.InternalServerError:
                if attempt >= 2:
                    raise
                logger.warning("Server error, retry %d/3", attempt + 1)
            except (openai.AuthenticationError, openai.PermissionDeniedError):
                raise
        raise RuntimeError("API call exhausted retries")


# ── System Prompts ───────────────────────────────────────────────

MATCH_SYSTEM_PROMPT = """\
You are a wiki matching specialist.
Compare the given raw document against the existing wiki list and decide whether to update an existing wiki or create a new one.

Respond ONLY with JSON:
- New wiki: {"action": "create", "title": "wiki title"}
- Update existing: {"action": "update", "target_wiki": "existing_wiki_filename.md", "title": "wiki title"}
"""

CREATE_SYSTEM_PROMPT = """\
You are an expert wiki author.
Analyze the raw document and produce a structured wiki note.

Rules:
1. Every factual sentence MUST have a raw source footnote ([^source]).
2. Include at least 3 country/region sections.
3. Include at least 3 representative cases/examples.
4. Do NOT add any content not present in the raw documents.
5. Include YAML frontmatter with tags, created date.
6. Write concretely so a new team member can perform the same task.
7. Write ALL output in Korean.
"""

UPDATE_SYSTEM_PROMPT = """\
You are an expert wiki update author.
Integrate new raw document information into the existing wiki note.

Rules:
1. Preserve the existing wiki's structure and tone.
2. Integrate new information into the appropriate sections.
3. Every new factual sentence MUST have a raw source footnote.
4. Keep existing footnotes and add new ones.
5. Do NOT add any content not present in the raw documents.
6. Remove duplicates and update with the latest information.
7. Write ALL output in Korean.
"""

REVISE_BASE_INSTRUCTIONS = """\
You are a wiki quality improvement specialist.
Apply feedback to revise ONLY the specific parts of the wiki note that need improvement.

Rules:
1. Do NOT rewrite the entire document — only produce diffs for sections that need changes.
2. Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
3. Every improvement MUST include a raw source footnote citation.
4. Do NOT use defensive hedging phrases (e.g., "사례 문서에서 직접 확인된"). Write direct factual sentences.
5. Replace long comma-separated item chains (5+ items) with grouped bullet/sub-bullet structure.
6. Reduce country/region section depth imbalance; if evidence is limited, add one explicit limitation bullet with citation.
7. Do NOT use markdown tables (| |). Use grouped bullet lists instead.

The existing wiki is provided as a JSON node array. Each node has {id, type, content, parent, indent}.

Respond ONLY with a JSON array of diffs:
[
  {"action": "update", "id": 3, "content": "revised content"},
  {"action": "insert_after", "id": 7, "type": "paragraph", "parent": 2, "content": "new paragraph"},
  {"action": "append_child", "parent": 5, "type": "list", "indent": 0, "content": "new item[^4]"},
  {"action": "delete", "id": 10}
]

Rules:
- Target nodes by id (NOT by line number or text matching).
- Only include diffs for parts that need changes.
- Preserve existing structure as much as possible, but reorganize overloaded comma-lists into bullets/sub-bullets when needed.
- Write ALL content values in Korean.
"""

REVISE_SYSTEM_PROMPT_IMPROVE = (
    REVISE_BASE_INSTRUCTIONS
    + """\
Current goal: Improve weak areas.
Improve items in order from lowest score to highest to raise overall quality.
Prioritize fixes for: (1) long comma-chain listings, (2) repetitive defensive phrasing, (3) country/region section depth imbalance.
"""
)

REVISE_SYSTEM_PROMPT_FIX_GATE = (
    REVISE_BASE_INSTRUCTIONS
    + """\
Current goal: Pass hard gates.
Fix failed gate items first. Use minimal changes to meet the requirements.
"""
)

REVISE_SYSTEM_PROMPT_RECOVERY = (
    REVISE_BASE_INSTRUCTIONS
    + """\
Current goal: Recover from score drop.
The previous revision caused a score decrease. Analyze the feedback more carefully and take a different approach.
"""
)

COUNTRY_RULES_ADDENDUM = """

## Country Wiki 추가 규칙

### 구조 규칙
1. JSONL spec이 정의한 canonical heading tree를 그대로 유지하라. 헤더 이름을 바꾸거나 새 헤더를 만들지 마라.
2. `## 규제 환경 요약`, `## 첨가물정보제출`, `## 분석결과제출`, `## 제품 규격 및 준수사항` 네 개의 최상위 섹션은 반드시 유지하라.
3. 제품군 차이가 필요하면 canonical 섹션 내부의 bullet로 표현하라. 헤더 안에 헤더를 넣거나 pseudo-heading을 만들지 마라.
4. 법규상 사실, review-backed interpretation, 사례 기반 practical note는 같은 canonical 섹션 안에서 구분해 쓸 수 있지만, 별도 비정규 헤더(`실무`, `법규`, `요약`)를 만들지 마라.

### 작성 형식
1. 각주 형식은 Obsidian wikilink를 사용하라. 본문은 `[^1]`, 각주 정의는 `[^1]: [[(파일명)#헤더]]`.
2. 들여쓰기는 4칸 스페이스만 사용하라. 탭 금지.
3. 번호 목록은 실제 절차 단계에만 사용하라. 제품군 라벨, 소주제 라벨, 해설 라벨에 번호 목록을 쓰지 마라.
4. 장문 쉼표 나열은 3~7개 의미 단위의 grouped bullets, 즉 읽기 쉬운 리스트 구조로 바꿔라.

### 내용 규칙
1. 원문과 source-backed review/case에 없는 내용 추가 금지.
2. 국가별 제도/기관/조문 스타일을 다른 국가식으로 바꾸지 마라.
3. Layer 1은 법문 중심, Layer 2는 review-backed clarification, Layer 3은 case-backed practical enrichment라는 역할 차이를 유지하라.
4. ALL output in Korean.
"""

COUNTRY_REVISE_ADDENDUM = """

Country-specific revision rules:
1. 각주 정의에서 `[^N]:` prefix가 중복되어 있으면 제거하라. content에는 `[[(파일명)#헤더]]`만 포함.
2. 텍스트 단락을 리스트로 변환하라. 3문장 이상의 연속 서술은 bullet로 분해.
3. 절차의 번호 순서를 반드시 유지하라. 기존 번호를 재배열하지 말라. 내용만 수정하라.
4. canonical heading tree를 깨지 마라. 기존 `##`, `###`, `####` heading node를 bullet이나 새 제목으로 바꾸지 마라.
5. Law Review 소스가 Tobacco Law와 충돌하는 부분은 Layer 2에서만 review-backed interpretation으로 덮어쓰고, 법문 사실 자체를 지우지 마라.
6. 서로 다른 제품군의 내용이 한 bullet에 섞여 있으면 제품군 라벨 bullet 또는 하위 bullet로 분리하라. 헤더를 새로 만들지 마라.
7. 들여쓰기는 반드시 4칸 스페이스. 탭 문자를 생성하지 말라.
"""

COUNTRY_ALIASES: dict[str, list[str]] = {
    "taiwan": ["taiwan", "taiwan _china", "대만", "台灣"],
    "russia": ["russia", "russian federation", "러시아", "Россия"],
    "turkey": ["turkey", "türkiye", "튀르키예", "터키"],
    "uzbekistan": ["uzbekistan", "우즈베키스탄"],
    "kazakhstan": ["kazakhstan", "카자흐스탄"],
    "israel": ["israel", "이스라엘"],
    "thailand": ["thailand", "태국", "泰國"],
    "australia": ["australia", "호주"],
    "germany": ["germany", "독일", "Deutschland"],
    "uae": ["uae", "united arab emirates", "아랍에미레이트"],
    "egypt": ["egypt", "이집트", "مصر"],
    "timor-leste": ["timor-leste", "east timor", "동티모르", "Timor-Leste"],
    "georgia": ["georgia", "조지아", "საქართველო"],
    "maldives": ["maldives", "몰디브"],
    "north-macedonia": [
        "north macedonia",
        "north-macedonia",
        "북마케도니아",
        "Северна Македонија",
    ],
}


def _normalize_country(raw: str) -> str:
    """YAML country 값을 정규화된 키로 변환."""
    raw_lower = raw.strip().lower()
    for key, aliases in COUNTRY_ALIASES.items():
        if raw_lower in [a.lower() for a in aliases]:
            return key
    return raw_lower


def _filter_docs_by_country(docs: list[Path], country: str) -> list[Path]:
    """YAML frontmatter의 country 필드로 문서 필터링. 3중 fallback."""
    import yaml

    matched = []
    target = _normalize_country(country)
    for doc in docs:
        try:
            text = doc.read_text(encoding="utf-8")
            if text.startswith("---"):
                end = text.find("---", 3)
                if end > 0:
                    fm = yaml.safe_load(text[3:end])
                    if fm and isinstance(fm, dict):
                        doc_country = fm.get("country", "")
                        if _normalize_country(str(doc_country)) == target:
                            matched.append(doc)
                            continue
        except Exception:
            pass
        # 파일명 기반 fallback (한글 국가명 매칭)
        kr_names = [a for a in COUNTRY_ALIASES.get(target, []) if not a.isascii()]
        if any(name in doc.name for name in kr_names):
            matched.append(doc)
        # 폴더명 기반 fallback (path-segment 매칭)
        elif target in [p.lower() for p in doc.parent.parts]:
            matched.append(doc)
    return matched


def _discover_archive_mentions(vault_root: Path, country: str) -> list[Path]:
    aliases = COUNTRY_ALIASES.get(_normalize_country(country), [country])
    needles = [a.lower() for a in aliases]
    roots = [vault_root / "4. Archive" / "work", vault_root / "4. Archive" / "Daily"]
    matched: dict[str, Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for doc in root.rglob("*.md"):
            try:
                text = doc.read_text(encoding="utf-8")
            except Exception:
                continue
            blob = f"{doc.name}\n{text}".lower()
            if any(needle in blob for needle in needles):
                matched[str(doc)] = doc
    return sorted(matched.values())


# ── WikiTask ─────────────────────────────────────────────────────
class WikiTask:
    """Wiki create/update task with own generalist agent.

    Implements TaskProtocol (run/revise) for use with quality-loop engine.
    Uses its own WikiAgent for content generation — does NOT depend on
    context.agents from the quality loop.
    """

    def __init__(self):
        self.agent = WikiAgent()

    def run(self, context) -> RunResult:
        """Dispatch to synthesis or legacy mode based on context.config."""
        if context.config.get("country"):
            return self._run_country_synthesis(context)
        if context.config.get("domain"):
            return self._run_synthesis(context)
        return self._run_legacy(context)

    def _run_synthesis(self, context) -> RunResult:
        """N:1 synthesis mode: discover → classify → synthesize → save."""
        domain = context.config["domain"]
        base_path = Path(context.config.get("base_path", ""))
        vault_root = Path(context.config.get("vault_root", ""))
        requested_filter_pattern = context.config.get("filter")
        effective_filter_pattern = requested_filter_pattern

        # wiki_output_dir is required
        wiki_output_dir = context.config.get("wiki_output_dir")
        if not wiki_output_dir:
            raise ValueError("wiki_output_dir is required in context_config")

        # 1. Discover inputs (or use pre-filtered docs)
        prefilled = context.config.get("prefilled_docs")
        if prefilled:
            all_docs = [Path(p) for p in prefilled]
            logger.info("Using %d pre-filtered docs", len(all_docs))
        else:
            parser = BaseIndexParser(vault_root)
            all_docs = parser.discover(
                base_path, view_name=domain, filter_pattern=requested_filter_pattern
            )

            # Safety guard: when caller omits filter, apply domain filename pattern
            # only if it actually matches at least one document.
            if not requested_filter_pattern:
                normalized_domain = re.sub(r"\s+", "", domain)
                auto_filter_token = AUTO_FILTER_DOMAIN_ALIASES.get(
                    normalized_domain, normalized_domain
                )
                auto_filter_pattern = f"({auto_filter_token})_*.md"
                narrowed = [
                    p for p in all_docs if fnmatch.fnmatch(p.name, auto_filter_pattern)
                ]
                if narrowed:
                    logger.info(
                        "Applying auto domain filter %s (%d -> %d docs)",
                        auto_filter_pattern,
                        len(all_docs),
                        len(narrowed),
                    )
                    all_docs = narrowed
                    effective_filter_pattern = auto_filter_pattern
                else:
                    logger.info(
                        "Auto domain filter %s matched 0 docs; keeping base/view matches (%d docs)",
                        auto_filter_pattern,
                        len(all_docs),
                    )

        # Optional: limit docs for testing
        max_docs = context.config.get("max_docs")
        if max_docs and isinstance(max_docs, int) and max_docs < len(all_docs):
            logger.info("Limiting to %d/%d docs (max_docs)", max_docs, len(all_docs))
            all_docs = all_docs[:max_docs]

        # 2. Track changes
        tracker = WikiTracker()
        new, changed, unchanged = tracker.classify_docs(all_docs)

        # 3. Early exit if no changes
        docs_to_process = new + changed
        if not docs_to_process:
            logger.info(
                "No new or changed docs for domain=%s (%d unchanged). Skipping synthesis.",
                domain,
                len(unchanged),
            )
            existing_wiki = self._load_existing_wiki(
                context.reference_files, domain, wiki_output_dir
            )
            if existing_wiki:
                context.output_dir.mkdir(parents=True, exist_ok=True)
                out_path = context.output_dir / f"{domain}.md"
                out_path.write_text(existing_wiki, encoding="utf-8")
                return RunResult(
                    output_files=[out_path],
                    metadata={
                        "domain": domain,
                        "wiki_output_dir": wiki_output_dir,
                        "skipped": True,
                        "reason": "no_changes",
                        "unchanged_count": len(unchanged),
                    },
                )
            return RunResult(
                output_files=[],
                metadata={
                    "domain": domain,
                    "skipped": True,
                    "reason": "no_changes_no_existing",
                },
            )

        # Synthesize
        doc_structure = context.config.get("doc_structure")
        synthesizer = ChunkedSynthesizer(
            self.agent,
            doc_structure=doc_structure,
            vault_root=vault_root,
            extract_prompt_override=context.config.get("spec_extract_prompt"),
            compose_prompt_override=context.config.get("spec_compose_prompt"),
        )
        existing_wiki = self._load_existing_wiki(
            context.reference_files, domain, wiki_output_dir
        )
        wiki_content, succeeded_docs = synthesizer.synthesize(
            docs_to_process, existing_wiki, domain, cache_dir=context.output_dir
        )

        # MAP 실패 시 빈 결과 → 루프가 빈 output으로 탈출하도록
        if not wiki_content or not wiki_content.strip():
            logger.error(
                "Synthesis returned empty wiki for domain=%s. MAP may have failed (file access or insufficient claims).",
                domain,
            )
            return RunResult(
                output_files=[],
                metadata={
                    "domain": domain,
                    "error": "MAP_SYNTHESIS_FAILED",
                    "docs_attempted": len(docs_to_process),
                },
            )

        # 4. Save (DB tracking deferred to engine after keep/converged verdict)
        # Domain lock: only write {domain}.md, never touch other domain files
        context.output_dir.mkdir(parents=True, exist_ok=True)
        allowed_filename = f"{domain}.md"
        out_path = context.output_dir / allowed_filename
        assert out_path.name == allowed_filename, (
            f"Domain lock violation: expected {allowed_filename}, got {out_path.name}"
        )
        out_path.write_text(wiki_content, encoding="utf-8")

        return RunResult(
            output_files=[out_path],
            metadata={
                "domain": domain,
                "base_path": str(base_path),
                "vault_root": str(vault_root),
                "wiki_output_dir": context.config.get("wiki_output_dir"),
                "filter_pattern": effective_filter_pattern,
                "all_docs": succeeded_docs,  # only successfully processed docs
                "docs_processed": [str(p) for p in docs_to_process],
            },
        )

    def _run_country_synthesis(self, context) -> RunResult:
        """Country mode: 단일 레이어의 소스 문서로 국가 wiki 생성/업데이트."""
        country = context.config["country"]
        layer = context.config.get("layer", "tobacco_law")
        vault_root = Path(context.config.get("vault_root", ""))
        wiki_output_dir = context.config.get("wiki_output_dir")

        # 1. 소스 문서 수집
        docs = self._discover_country_docs(context, country, layer, vault_root)
        if not docs:
            existing = self._load_existing_wiki(
                context.reference_files, country, wiki_output_dir
            )
            if existing:
                context.output_dir.mkdir(parents=True, exist_ok=True)
                out_path = context.output_dir / f"{country}.md"
                out_path.write_text(existing, encoding="utf-8")
                return RunResult(
                    output_files=[out_path],
                    metadata={"country": country, "layer": layer, "skipped": True},
                )
            return RunResult(
                output_files=[],
                metadata={"country": country, "layer": layer, "skipped": True},
            )

        # 2. 기존 wiki 로드
        existing_wiki = self._load_existing_wiki(
            context.reference_files, country, wiki_output_dir
        )

        # 3. Synthesizer with country addendum
        doc_structure = context.config.get("doc_structure")
        synthesizer = ChunkedSynthesizer(
            self.agent,
            doc_structure=doc_structure,
            vault_root=vault_root,
            country_filter=country,
            system_prompt_addendum=COUNTRY_RULES_ADDENDUM,
            extract_prompt_override=context.config.get("spec_extract_prompt"),
            compose_prompt_override=context.config.get("spec_compose_prompt"),
            update_prompt_override=context.config.get("spec_update_prompt"),
        )
        wiki_content, succeeded = synthesizer.synthesize(
            docs, existing_wiki, country, cache_dir=context.output_dir
        )

        if not wiki_content or not wiki_content.strip():
            return RunResult(
                output_files=[],
                metadata={
                    "country": country,
                    "layer": layer,
                    "error": "SYNTHESIS_FAILED",
                },
            )

        # 4. 저장
        context.output_dir.mkdir(parents=True, exist_ok=True)
        out_path = context.output_dir / f"{country}.md"
        out_path.write_text(wiki_content, encoding="utf-8")

        return RunResult(
            output_files=[out_path],
            metadata={
                "country": country,
                "layer": layer,
                "all_docs": succeeded,
                "wiki_output_dir": wiki_output_dir,
            },
        )

    def _discover_country_docs(
        self, context, country: str, layer: str, vault_root: Path
    ) -> list[Path]:
        """레이어별 소스 문서 발견 + country 필터."""
        base_path = Path(context.config.get("base_path", ""))
        parser = BaseIndexParser(vault_root)
        view_map = {
            "tobacco_law": "Tobacco Law",
            "law_review": "Law Reviews",
        }
        if layer == "compliance":
            all_docs = []
        else:
            view_name = view_map.get(layer, layer)
            all_docs = parser.discover(base_path, view_name=view_name)

        if layer == "compliance":
            extra_docs = parser.discover(base_path, filter_pattern="(규제준수)_*.md")
            merged: dict[str, Path] = {str(p): p for p in all_docs}
            for doc in extra_docs:
                merged[str(doc)] = doc
            for doc in _discover_archive_mentions(vault_root, country):
                merged[str(doc)] = doc
            all_docs = sorted(merged.values())

        return _filter_docs_by_country(all_docs, country)

    def _run_legacy(self, context) -> RunResult:
        """Original 1:1 doc → wiki note mode."""
        output_files: list[Path] = []

        for doc_path in context.input_files:
            doc_text = doc_path.read_text(encoding="utf-8")

            # 1. Match against existing wiki
            wiki_index = self._build_wiki_index(context.reference_files)
            match_raw = self.agent.generate(
                system_prompt=MATCH_SYSTEM_PROMPT,
                user_prompt=f"문서:\n{doc_text}\n\nwiki 목록:\n{wiki_index}",
            )

            match_result = try_parse_validated(match_raw, WikiMatchDecision)
            if match_result:
                match = {
                    "action": match_result.action,
                    "target_wiki": match_result.target_wiki,
                    "title": match_result.title,
                }
            else:
                logger.warning("Match response parse failed, defaulting to create")
                match = {"action": "create", "title": doc_path.stem}

            # 2. Generate or update wiki note
            if match.get("action") == "update" and match.get("target_wiki"):
                target_path = self._find_reference(
                    match["target_wiki"], context.reference_files
                )
                if target_path and target_path.exists():
                    existing = target_path.read_text(encoding="utf-8")
                    wiki_content = self.agent.generate(
                        system_prompt=UPDATE_SYSTEM_PROMPT,
                        user_prompt=f"기존 wiki:\n{existing}\n\n새 raw:\n{doc_text}",
                    )
                else:
                    wiki_content = self.agent.generate(
                        system_prompt=CREATE_SYSTEM_PROMPT,
                        user_prompt=f"raw 문서:\n{doc_text}",
                    )
            else:
                wiki_content = self.agent.generate(
                    system_prompt=CREATE_SYSTEM_PROMPT,
                    user_prompt=f"raw 문서:\n{doc_text}",
                )

            # 3. Save
            title = match.get("title", doc_path.stem)
            safe_title = "".join(
                c if c.isalnum() or c in (" ", "-", "_", ".") else "_" for c in title
            ).strip()
            out_path = context.output_dir / f"{safe_title}.md"
            out_path.write_text(wiki_content, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def revise(self, context, feedback) -> RunResult:
        """Revise wiki notes via heading-path based sections (not line diffs)."""
        output_files: list[Path] = []

        system_prompt = context.config.get(
            "spec_revise_prompt"
        ) or self._select_revise_prompt(feedback)
        if context.config.get("country"):
            system_prompt = system_prompt + COUNTRY_REVISE_ADDENDUM

        for prev_file in feedback.previous_output_files:
            existing_wiki = prev_file.read_text(encoding="utf-8")
            revision_prompt = self._build_revision_prompt(
                existing_wiki, feedback, context.reference_files
            )

            diff_response = self.agent.generate(
                system_prompt=system_prompt,
                user_prompt=revision_prompt,
            )

            # Apply JSON node diffs to existing wiki
            revised = self._apply_section_diffs(
                existing_wiki, diff_response, existing_wiki
            )
            revised = strip_code_blocks(revised)
            revised = filter_attachment_footnotes(revised)
            revised = canonicalize_regulation_markdown(
                revised, context.config.get("doc_structure")
            )
            revised = preserve_canonical_subtrees(revised, existing_wiki)

            out_path = context.output_dir / prev_file.name
            out_path.write_text(revised, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def _select_revise_prompt(self, feedback) -> str:
        """Choose the most appropriate system prompt based on feedback state."""
        # 1. Recovery mode: score dropped from previous iteration
        if (
            feedback.previous_score is not None
            and feedback.total_score < feedback.previous_score
        ):
            logger.info(
                "Revision: Entering recovery mode (score drop: %.1f -> %.1f)",
                feedback.previous_score,
                feedback.total_score,
            )
            return REVISE_SYSTEM_PROMPT_RECOVERY

        # 2. Fix Gate mode: has hard gate failures
        if feedback.hard_gate_failures:
            logger.info(
                "Revision: Entering fix-gate mode (%d failures)",
                len(feedback.hard_gate_failures),
            )
            return REVISE_SYSTEM_PROMPT_FIX_GATE

        # 3. Default: Improve mode
        return REVISE_SYSTEM_PROMPT_IMPROVE

    def _apply_section_diffs(
        self, original: str, response: str, reference_wiki: str | None = None
    ) -> str:
        """Apply JSON node diffs from LLM response."""
        nodes = md_to_json(original)
        try:
            diffs = parse_validated_list(response, MdDiff)
        except ValueError as exc:
            logger.warning(
                "MdDiff parse failed, keeping original. error=%s response_preview=%.500s",
                exc,
                response,
            )
            return original
        if not diffs:
            logger.warning(
                "MdDiff response yielded 0 valid diffs. response_preview=%.500s",
                response,
            )
            return original
        logger.info("Applying %d MdDiff operations", len(diffs))
        updated = apply_json_diffs(nodes, diffs)
        updated_md = json_to_md(updated)
        updated_md = canonicalize_regulation_markdown(updated_md, None)
        return preserve_canonical_subtrees(updated_md, reference_wiki or original)

    def _load_existing_wiki(
        self,
        reference_files: list[Path],
        domain: str,
        wiki_output_dir: str | None = None,
    ) -> str | None:
        """Find and return the existing wiki note for domain.

        Priority: DB output_path → reference_files → wiki_output_dir/{domain}.md.
        """
        # 1. Try DB — latest completed run's output
        try:
            tracker = WikiTracker()
            db_path = tracker.get_latest_wiki_path(domain)
            if db_path and db_path.exists():
                logger.info("Loading existing wiki from DB: %s", db_path)
                return db_path.read_text(encoding="utf-8")
        except Exception:
            pass

        # 2. Fallback to reference_files
        for ref in reference_files:
            if ref.stem == domain and ref.suffix == ".md":
                return ref.read_text(encoding="utf-8")

        # 3. Fallback to wiki_output_dir/{domain}.md
        if wiki_output_dir:
            candidate = Path(wiki_output_dir) / f"{domain}.md"
            if candidate.exists():
                logger.info("Loading existing wiki from wiki_output_dir: %s", candidate)
                return candidate.read_text(encoding="utf-8")

        return None

    def _build_wiki_index(self, reference_files: list[Path]) -> str:
        lines: list[str] = []
        for ref in reference_files:
            if ref.suffix == ".md":
                lines.append(f"- {ref.name}")
        return "\n".join(lines) if lines else "(wiki 없음)"

    def _find_reference(
        self, filename: str, reference_files: list[Path]
    ) -> Path | None:
        for ref in reference_files:
            if ref.name == filename:
                return ref
        return None

    def _build_revision_prompt(
        self,
        content: str,
        feedback,
        reference_files: list[Path],
    ) -> str:
        nodes = md_to_json(content)
        nodes_json = json.dumps(
            [n.model_dump() for n in nodes], ensure_ascii=False, indent=2
        )
        lines = [f"현재 wiki note (JSON 노드):\n{nodes_json}\n"]
        lines.append(f"총점: {feedback.total_score}\n")

        if feedback.hard_gate_failures:
            lines.append("## 하드 게이트 실패 (최우선 수정)")
            for g in feedback.hard_gate_failures:
                lines.append(f"- {g.message}")

        lines.append("\n## 항목별 피드백 (점수 낮은 순)")
        for item in feedback.items:
            lines.append(f"### {item.name} ({item.score}/{item.max_score})")
            lines.append(f"근거: {item.rationale}")
            for imp in item.improvements:
                lines.append(f"- 개선: {imp}")

        lines.append("\n## 참조 소스 (raw 문서)")
        for ref in reference_files:
            if ref.exists() and ref.suffix == ".md":
                try:
                    ref_text = ref.read_text(encoding="utf-8")
                    lines.append(f"### {ref.name}\n{ref_text}\n")
                except Exception:
                    lines.append(f"### {ref.name}\n(읽기 실패)\n")

        return "\n".join(lines)
