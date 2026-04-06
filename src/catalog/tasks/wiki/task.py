"""WikiTask - wiki generation/revision with own generalist agent.

This task is independent of the quality-loop engine. It can run standalone
or be wrapped by the karpathy-loop for rubric-based iterative improvement.
When wrapped, the loop's reviewer agent evaluates; this task's generalist
agent generates and revises.
"""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
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
except ImportError:
    from base_index import BaseIndexParser  # type: ignore[no-redef]
    from synthesizer import ChunkedSynthesizer  # type: ignore[no-redef]
    from wiki_tracker import WikiTracker  # type: ignore[no-redef]
    from json_utils import extract_json, parse_validated, parse_validated_list, try_parse_validated  # type: ignore[no-redef]


class WikiMatchDecision(BaseModel):
    action: Literal["create", "update"]
    target_wiki: str | None = None
    title: str


class SectionEdit(BaseModel):
    action: Literal["replace_section", "append_to", "add_section"]
    heading_path: str | None = None
    parent_heading_path: str | None = None
    new_heading: str | None = None
    content: str


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


# ── Local Gemma ──────────────────────────────────────────────────
GEMMA_SCRIPT = Path.home() / "Automation" / "local_llm_model" / "run_local_gemma.sh"
GEMMA_MODELS = {"gemma4-26b": "26b", "gemma4-e4b": "e4b"}


class LocalGemmaAgent:
    """Local Gemma4 agent via subprocess."""

    def __init__(self, model: str = "gemma4-26b"):
        self.model_key = GEMMA_MODELS.get(model, "26b")
        self.model = model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        prompt = f"{system_prompt}\n\n{user_prompt}"
        result = subprocess.run(
            [str(GEMMA_SCRIPT), self.model_key, "generate", prompt],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Gemma failed (exit {result.returncode})")
        parts = result.stdout.split("==========")
        return parts[1].strip() if len(parts) >= 2 else result.stdout.strip()


# ── Agent ────────────────────────────────────────────────────────
class WikiAgent:
    """Generalist agent for wiki content generation."""

    def __init__(self, model: str | None = None):
        # Local Gemma models
        if model in GEMMA_MODELS:
            self._local = LocalGemmaAgent(model)
            self._use_chatgpt = False
            self._use_local = True
            self.model = model
            return

        self._use_local = False
        backend = os.environ.get("NANOCLAW_AGENT_BACKEND", "")

        # Try ChatGPT OAuth first when auth.json exists and no explicit backend override
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

        if backend in ("zai", "openai-compat"):
            api_key = os.environ.get("OPENAI_COMPAT_API_KEY", "")
            base_url = os.environ.get("OPENAI_COMPAT_BASE_URL", "https://api.z.ai/api/paas/v4/")
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "glm-5")
        elif backend == "openai":
            api_key = os.environ.get("OPENAI_API_KEY", "")
            base_url = os.environ.get("OPENAI_BASE_URL") or None
            default_model = os.environ.get("QUALITY_LOOP_MODEL", "gpt-5.4")
        else:  # opencode or other
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
당신은 wiki 매칭 전문가입니다.
주어진 raw 문서와 기존 wiki 목록을 비교하여, 이 문서가 기존 wiki를 업데이트해야 하는지, \
새로운 wiki를 생성해야 하는지 판단합니다.

반드시 JSON으로만 응답하세요:
- 새 wiki 생성: {"action": "create", "title": "wiki 제목"}
- 기존 wiki 업데이트: {"action": "update", "target_wiki": "기존_wiki_파일명.md", "title": "wiki 제목"}
"""

CREATE_SYSTEM_PROMPT = """\
당신은 전문 wiki 작성자입니다.
raw 문서를 분석하여 구조화된 wiki note를 작성합니다.

규칙:
1. 모든 서술 문장에 raw 출처 각주([^출처명])를 달 것
2. 최소 3개 국가/지역 섹션을 포함할 것
3. 최소 3개 대표 사례/예시를 포함할 것
4. raw 문서에 없는 내용을 추가하지 말 것
5. YAML frontmatter에 태그, 생성일, 출처를 포함할 것
6. 신규 담당자가 업무를 수행할 수 있도록 절차와 기준을 구체적으로 작성할 것
"""

UPDATE_SYSTEM_PROMPT = """\
당신은 전문 wiki 업데이트 작성자입니다.
기존 wiki note에 새 raw 문서의 정보를 통합합니다.

규칙:
1. 기존 wiki의 구조와 톤을 유지할 것
2. 새 정보를 적절한 섹션에 통합할 것
3. 모든 새 서술 문장에 raw 출처 각주를 달 것
4. 기존 각주를 유지하고 새 각주를 추가할 것
5. raw 문서에 없는 내용을 추가하지 말 것
6. 중복 내용을 제거하고 최신 정보로 갱신할 것
"""

REVISE_BASE_INSTRUCTIONS = """\
당신은 wiki 품질 개선 전문가입니다.
피드백을 반영하여 wiki note의 특정 부분만 수정합니다.

규칙:
1. 전체 문서를 다시 작성하지 말 것 — 수정이 필요한 부분만 섹션 단위로 수정할 것
2. raw 문서에 없는 내용을 절대 추가하지 말 것 (hallucination 금지)
3. 각 개선 사항에 대해 raw 출처 각주를 반드시 달 것

수정 방식 (JSON 배열):
- replace_section: 특정 섹션의 본문 내용을 교체 (제목은 유지)
- add_section: 새로운 섹션을 특정 섹션 뒤에 추가 (부모 섹션 경로 지정)
- append_to: 특정 섹션의 끝에 내용을 추가

응답 형식:
```json
[
  {
    "action": "replace_section",
    "heading_path": "## 섹션1 > ### 서브섹션1.1",
    "content": "교체할 새 본문 내용 (각주 포함)"
  },
  {
    "action": "add_section",
    "parent_heading_path": "## 섹션1",
    "new_heading": "### 신규 서브섹션",
    "content": "신규 섹션의 내용"
  },
  {
    "action": "append_to",
    "heading_path": "## 섹션2",
    "content": "추가할 내용"
  }
]
```

주의:
- heading_path는 '## 제목1 > ### 제목2' 와 같은 형식으로 정확히 지정할 것
- content에는 마크다운 문법을 사용할 수 있음
"""

REVISE_SYSTEM_PROMPT_IMPROVE = REVISE_BASE_INSTRUCTIONS + """\
현재 목표: 약한 영역 개선
점수가 낮은 항목부터 순서대로 개선하여 품질을 높이세요.
"""

REVISE_SYSTEM_PROMPT_FIX_GATE = REVISE_BASE_INSTRUCTIONS + """\
현재 목표: 하드 게이트 통과
실패한 게이트 항목을 최우선으로 해결하세요. 최소한의 수정으로 요구사항을 충족하세요.
"""

REVISE_SYSTEM_PROMPT_RECOVERY = REVISE_BASE_INSTRUCTIONS + """\
현재 목표: 점수 하락 복구
이전 수정에서 점수가 떨어졌습니다. 피드백을 더 엄격하게 분석하여 다른 방식으로 접근하세요.
"""


# ── MarkdownSectionEditor ──────────────────────────────────────────
class MarkdownSectionEditor:
    """Helper to edit Markdown sections using heading paths as anchors."""

    def __init__(self, content: str):
        self.lines = content.split("\n")

    def find_section(self, heading_path: str) -> tuple[int, int] | None:
        """Find line indices of a section. Returns (start_idx, end_idx) or None."""
        path_parts = [p.strip() for p in heading_path.split(">")]
        current_idx = 0
        start_idx = -1

        for part in path_parts:
            found = False
            for i in range(current_idx, len(self.lines)):
                if self.lines[i].strip() == part:
                    current_idx = i
                    start_idx = i
                    found = True
                    break
            if not found:
                return None

        if start_idx == -1:
            return None

        # Determine level of the leaf heading
        m = re.match(r"^(#+)", path_parts[-1])
        level = len(m.group(1)) if m else 0

        end_idx = len(self.lines) - 1
        for i in range(start_idx + 1, len(self.lines)):
            line = self.lines[i].strip()
            if line.startswith("#"):
                m_inner = re.match(r"^(#+)", line)
                if m_inner and len(m_inner.group(1)) <= level:
                    end_idx = i - 1
                    break
        return (start_idx, end_idx)

    def replace_section(self, heading_path: str, content: str) -> bool:
        r = self.find_section(heading_path)
        if not r: return False
        start, end = r
        self.lines[start + 1 : end + 1] = content.split("\n")
        return True

    def append_to_section(self, heading_path: str, content: str) -> bool:
        r = self.find_section(heading_path)
        if not r: return False
        _, end = r
        new_lines = content.split("\n")
        if self.lines[end].strip() != "" and new_lines:
            self.lines.insert(end + 1, "")
            end += 1
        self.lines[end + 1 : end + 1] = new_lines
        return True

    def add_section(self, parent_path: str, new_heading: str, content: str) -> bool:
        r = self.find_section(parent_path)
        if not r: return False
        _, end = r
        new_sec = [new_heading] + content.split("\n")
        self.lines[end + 1 : end + 1] = ["", ""] + new_sec
        return True

    def get_content(self) -> str:
        return "\n".join(self.lines)


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
        filter_pattern = context.config.get("filter")

        # 1. Discover inputs
        parser = BaseIndexParser(vault_root)
        all_docs = parser.discover(base_path, filter_pattern=filter_pattern)

        # Optional: limit docs for testing
        max_docs = context.config.get("max_docs")
        if max_docs and isinstance(max_docs, int) and max_docs < len(all_docs):
            logger.info("Limiting to %d/%d docs (max_docs)", max_docs, len(all_docs))
            all_docs = all_docs[:max_docs]

        # 2. Track changes
        tracker = WikiTracker()
        new, changed, unchanged = tracker.classify_docs(all_docs)

        # 3. Synthesize
        synthesizer = ChunkedSynthesizer(self.agent)
        existing_wiki = self._load_existing_wiki(context.reference_files, domain)
        docs_to_process = new + changed
        wiki_content = synthesizer.synthesize(docs_to_process, existing_wiki, domain)

        # 4. Save + track
        context.output_dir.mkdir(parents=True, exist_ok=True)
        out_path = context.output_dir / f"{domain}.md"
        out_path.write_text(wiki_content, encoding="utf-8")

        run_id = getattr(context, "run_id", str(uuid.uuid4()))
        tracker.record_run(run_id, domain, str(base_path), filter_pattern, all_docs, {})
        tracker.complete_run(run_id, output_count=1)

        return RunResult(output_files=[out_path])

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

            # Apply section-based diffs to existing wiki
            revised = self._apply_section_diffs(existing_wiki, diff_response)

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
        """Apply section-based edits from LLM JSON response."""
        try:
            edits = parse_validated_list(response, SectionEdit)
        except ValueError:
            logger.warning("Section diff parse failed, keeping original")
            return original

        if not edits:
            logger.warning("Section diff response is not a list or is empty")
            return original

        editor = MarkdownSectionEditor(original)
        applied = 0
        for i, edit in enumerate(edits):
            success = False

            if edit.action == "replace_section":
                success = editor.replace_section(
                    edit.heading_path or "", edit.content
                )
            elif edit.action == "append_to":
                success = editor.append_to_section(
                    edit.heading_path or "", edit.content
                )
            elif edit.action == "add_section":
                success = editor.add_section(
                    edit.parent_heading_path or "",
                    edit.new_heading or "",
                    edit.content,
                )

            if success:
                applied += 1
            else:
                logger.warning("Edit #%d (%s) failed for path: %s",
                               i, edit.action, edit.heading_path or edit.parent_heading_path)

        logger.info("Applied %d/%d section edits", applied, len(edits))
        return editor.get_content() if applied > 0 else original

    def _load_existing_wiki(self, reference_files: list[Path], domain: str) -> str | None:
        """Find and return the existing wiki note for domain, or None."""
        for ref in reference_files:
            if ref.stem == domain and ref.suffix == ".md":
                return ref.read_text(encoding="utf-8")
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
        lines = [f"현재 wiki note 본문:\n{content}\n"]
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
