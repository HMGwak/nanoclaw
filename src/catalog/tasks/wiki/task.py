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
    from .json_utils import extract_json, parse_validated, parse_validated_list, try_parse_validated
    from .markdown_utils import MarkdownSectionEditor, SectionEdit, md_to_json, json_to_md, apply_json_diffs, MdNode, MdDiff, strip_code_blocks, filter_attachment_footnotes
except ImportError:
    from base_index import BaseIndexParser  # type: ignore[no-redef]
    from synthesizer import ChunkedSynthesizer  # type: ignore[no-redef]
    from wiki_tracker import WikiTracker  # type: ignore[no-redef]
    from json_utils import extract_json, parse_validated, parse_validated_list, try_parse_validated  # type: ignore[no-redef]
    from markdown_utils import MarkdownSectionEditor, SectionEdit, md_to_json, json_to_md, apply_json_diffs, MdNode, MdDiff, strip_code_blocks, filter_attachment_footnotes  # type: ignore[no-redef]


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
        if hasattr(tokenizer, 'apply_chat_template'):
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
            model, tokenizer, prompt=prompt,
            max_tokens=self._max_tokens, sampler=sampler, verbose=False,
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
            base_url = os.environ.get("OPENAI_COMPAT_BASE_URL", "https://api.z.ai/api/paas/v4/")
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "glm-5")
        else:
            api_key = os.environ.get("OPENAI_API_KEY", "") or os.environ.get("OPENCODE_API_KEY", "")
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
                logger.warning("Rate limited, retry %d/%d after %ds", attempt + 1, max_retries, delay)
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

REVISE_SYSTEM_PROMPT_IMPROVE = REVISE_BASE_INSTRUCTIONS + """\
Current goal: Improve weak areas.
Improve items in order from lowest score to highest to raise overall quality.
Prioritize fixes for: (1) long comma-chain listings, (2) repetitive defensive phrasing, (3) country/region section depth imbalance.
"""

REVISE_SYSTEM_PROMPT_FIX_GATE = REVISE_BASE_INSTRUCTIONS + """\
Current goal: Pass hard gates.
Fix failed gate items first. Use minimal changes to meet the requirements.
"""

REVISE_SYSTEM_PROMPT_RECOVERY = REVISE_BASE_INSTRUCTIONS + """\
Current goal: Recover from score drop.
The previous revision caused a score decrease. Analyze the feedback more carefully and take a different approach.
"""


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
            all_docs = parser.discover(base_path, view_name=domain, filter_pattern=requested_filter_pattern)

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
            logger.info("No new or changed docs for domain=%s (%d unchanged). Skipping synthesis.", domain, len(unchanged))
            existing_wiki = self._load_existing_wiki(context.reference_files, domain, wiki_output_dir)
            if existing_wiki:
                context.output_dir.mkdir(parents=True, exist_ok=True)
                out_path = context.output_dir / f"{domain}.md"
                out_path.write_text(existing_wiki, encoding="utf-8")
                return RunResult(
                    output_files=[out_path],
                    metadata={"domain": domain, "wiki_output_dir": wiki_output_dir, "skipped": True, "reason": "no_changes", "unchanged_count": len(unchanged)},
                )
            return RunResult(output_files=[], metadata={"domain": domain, "skipped": True, "reason": "no_changes_no_existing"})

        # Synthesize
        doc_structure = context.config.get("doc_structure")
        synthesizer = ChunkedSynthesizer(self.agent, doc_structure=doc_structure, vault_root=vault_root)
        existing_wiki = self._load_existing_wiki(context.reference_files, domain, wiki_output_dir)
        wiki_content, succeeded_docs = synthesizer.synthesize(docs_to_process, existing_wiki, domain, cache_dir=context.output_dir)

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
                match = {"action": match_result.action, "target_wiki": match_result.target_wiki, "title": match_result.title}
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
                c if c.isalnum() or c in (" ", "-", "_", ".") else "_"
                for c in title
            ).strip()
            out_path = context.output_dir / f"{safe_title}.md"
            out_path.write_text(wiki_content, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def revise(self, context, feedback) -> RunResult:
        """Revise wiki notes via heading-path based sections (not line diffs)."""
        output_files: list[Path] = []

        system_prompt = self._select_revise_prompt(feedback)

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
            revised = self._apply_section_diffs(existing_wiki, diff_response)
            revised = strip_code_blocks(revised)
            revised = filter_attachment_footnotes(revised)

            out_path = context.output_dir / prev_file.name
            out_path.write_text(revised, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def _select_revise_prompt(self, feedback) -> str:
        """Choose the most appropriate system prompt based on feedback state."""
        # 1. Recovery mode: score dropped from previous iteration
        if feedback.previous_score is not None and feedback.total_score < feedback.previous_score:
            logger.info("Revision: Entering recovery mode (score drop: %.1f -> %.1f)", 
                        feedback.previous_score, feedback.total_score)
            return REVISE_SYSTEM_PROMPT_RECOVERY
        
        # 2. Fix Gate mode: has hard gate failures
        if feedback.hard_gate_failures:
            logger.info("Revision: Entering fix-gate mode (%d failures)", len(feedback.hard_gate_failures))
            return REVISE_SYSTEM_PROMPT_FIX_GATE
            
        # 3. Default: Improve mode
        return REVISE_SYSTEM_PROMPT_IMPROVE

    def _apply_section_diffs(self, original: str, response: str) -> str:
        """Apply JSON node diffs from LLM response."""
        nodes = md_to_json(original)
        try:
            diffs = parse_validated_list(response, MdDiff)
        except ValueError as exc:
            logger.warning("MdDiff parse failed, keeping original. error=%s response_preview=%.500s", exc, response)
            return original
        if not diffs:
            logger.warning("MdDiff response yielded 0 valid diffs. response_preview=%.500s", response)
            return original
        logger.info("Applying %d MdDiff operations", len(diffs))
        updated = apply_json_diffs(nodes, diffs)
        return json_to_md(updated)

    def _load_existing_wiki(self, reference_files: list[Path], domain: str, wiki_output_dir: str | None = None) -> str | None:
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
        nodes_json = json.dumps([n.model_dump() for n in nodes], ensure_ascii=False, indent=2)
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
