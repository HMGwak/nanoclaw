"""WikiTask - first domain implementation (PRD section 10.2)."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .types import Context, Feedback, RunResult

logger = logging.getLogger(__name__)

# ── System Prompts ────────────────────────────────────────────────

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

REVISE_SYSTEM_PROMPT = """\
당신은 wiki 품질 개선 전문가입니다.
피드백을 반영하여 wiki note를 개선합니다.

규칙:
1. 피드백의 하드 게이트 실패 항목을 최우선으로 수정할 것
2. 점수가 낮은 항목부터 순서대로 개선할 것
3. raw 문서에 없는 내용을 절대 추가하지 말 것 (hallucination 금지)
4. 기존 구조를 가능한 유지하면서 개선할 것
5. 각 개선 사항에 대해 raw 출처 각주를 반드시 달 것
"""


class WikiTask:
    """Wiki ingest + create/update task implementing TaskProtocol."""

    def run(self, context: Context) -> RunResult:
        agents = context.agents
        output_files: list[Path] = []

        for doc_path in context.input_files:
            doc_text = doc_path.read_text(encoding="utf-8")

            # 1. Match against existing wiki
            wiki_index = self._build_wiki_index(context.reference_files)
            match_raw = agents.generate(
                system_prompt=MATCH_SYSTEM_PROMPT,
                user_prompt=f"문서:\n{doc_text}\n\nwiki 목록:\n{wiki_index}",
            )
            try:
                match = json.loads(_extract_json_from_text(match_raw))
            except (json.JSONDecodeError, ValueError):
                logger.warning("Match response parse failed, defaulting to create")
                match = {"action": "create", "title": doc_path.stem}

            # 2. Generate or update wiki note
            if match.get("action") == "update" and match.get("target_wiki"):
                # Find the target wiki file
                target_path = self._find_reference(
                    match["target_wiki"], context.reference_files
                )
                if target_path and target_path.exists():
                    existing = target_path.read_text(encoding="utf-8")
                    wiki_content = agents.generate(
                        system_prompt=UPDATE_SYSTEM_PROMPT,
                        user_prompt=f"기존 wiki:\n{existing}\n\n새 raw:\n{doc_text}",
                    )
                else:
                    wiki_content = agents.generate(
                        system_prompt=CREATE_SYSTEM_PROMPT,
                        user_prompt=f"raw 문서:\n{doc_text}",
                    )
            else:
                wiki_content = agents.generate(
                    system_prompt=CREATE_SYSTEM_PROMPT,
                    user_prompt=f"raw 문서:\n{doc_text}",
                )

            # 3. Save
            title = match.get("title", doc_path.stem)
            # Sanitize title for filename
            safe_title = "".join(
                c if c.isalnum() or c in (" ", "-", "_", ".") else "_"
                for c in title
            ).strip()
            out_path = context.output_dir / f"{safe_title}.md"
            out_path.write_text(wiki_content, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def revise(self, context: Context, feedback: Feedback) -> RunResult:
        agents = context.agents
        output_files: list[Path] = []

        for prev_file in feedback.previous_output_files:
            prev_content = prev_file.read_text(encoding="utf-8")

            revision_prompt = self._build_revision_prompt(
                prev_content, feedback, context.reference_files
            )

            revised = agents.generate(
                system_prompt=REVISE_SYSTEM_PROMPT,
                user_prompt=revision_prompt,
            )

            out_path = context.output_dir / prev_file.name
            out_path.write_text(revised, encoding="utf-8")
            output_files.append(out_path)

        return RunResult(output_files=output_files)

    def _build_wiki_index(self, reference_files: list[Path]) -> str:
        """Build a summary index of existing wiki files."""
        lines: list[str] = []
        for ref in reference_files:
            if ref.suffix == ".md":
                lines.append(f"- {ref.name}")
        return "\n".join(lines) if lines else "(wiki 없음)"

    def _find_reference(
        self, filename: str, reference_files: list[Path]
    ) -> Path | None:
        """Find a reference file by name."""
        for ref in reference_files:
            if ref.name == filename:
                return ref
        return None

    def _build_revision_prompt(
        self,
        content: str,
        feedback: Feedback,
        reference_files: list[Path],
    ) -> str:
        lines = [f"현재 wiki note:\n{content}\n"]
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

        # Attach reference sources
        lines.append("\n## 참조 소스 (raw 문서)")
        for ref in reference_files:
            if ref.exists() and ref.suffix == ".md":
                try:
                    ref_text = ref.read_text(encoding="utf-8")
                    lines.append(f"### {ref.name}\n{ref_text}\n")
                except Exception:
                    lines.append(f"### {ref.name}\n(읽기 실패)\n")

        return "\n".join(lines)


def _extract_json_from_text(text: str) -> str:
    """Extract JSON from LLM response text."""
    import re

    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text
