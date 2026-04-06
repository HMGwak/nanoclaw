"""Markdown section-based editing utilities."""

from __future__ import annotations

import re
from typing import Literal
try:
    from pydantic import BaseModel
except ModuleNotFoundError:
    class BaseModel:
        """Minimal fallback used when pydantic is unavailable."""

        def __init__(self, **data):
            for key, value in data.items():
                setattr(self, key, value)
            for key, value in self.__class__.__dict__.items():
                if key.startswith("_"):
                    continue
                if callable(value) or isinstance(value, property):
                    continue
                if key not in self.__dict__:
                    setattr(self, key, value)

        def model_copy(self, deep: bool = False):
            copied = {}
            for key, value in self.__dict__.items():
                if deep and isinstance(value, list):
                    copied[key] = list(value)
                elif deep and isinstance(value, dict):
                    copied[key] = dict(value)
                else:
                    copied[key] = value
            return self.__class__(**copied)


class SectionEdit(BaseModel):
    action: Literal["replace_section", "append_to", "add_section"]
    heading_path: str | None = None
    parent_heading_path: str | None = None
    new_heading: str | None = None
    content: str


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
        if not r:
            return False
        start, end = r
        self.lines[start + 1 : end + 1] = content.split("\n")
        return True

    def append_to_section(self, heading_path: str, content: str) -> bool:
        r = self.find_section(heading_path)
        if not r:
            return False
        _, end = r
        new_lines = content.split("\n")
        # Ensure there's a blank line before appending if the section is not empty
        if end > 0 and self.lines[end].strip() != "" and new_lines:
            self.lines.insert(end + 1, "")
            end += 1
        self.lines[end + 1 : end + 1] = new_lines
        return True

    def add_section(self, parent_path: str, new_heading: str, content: str) -> bool:
        r = self.find_section(parent_path)
        if not r:
            return False
        _, end = r
        new_sec = [new_heading] + content.split("\n")
        self.lines[end + 1 : end + 1] = ["", ""] + new_sec
        return True

    def get_content(self) -> str:
        return "\n".join(self.lines)


def strip_code_blocks(content: str) -> str:
    """Remove Markdown code blocks (```...```) from the content."""
    return re.sub(r"```.*?```", "", content, flags=re.DOTALL).strip()


def filter_attachment_footnotes(content: str) -> str:
    """Remove footnotes that point to non-markdown attachments (e.g. .pdf, .docx)."""
    # Footnote definitions look like [^1]: [[(안전성검토)_파일명.pdf]]
    # We want to remove lines like [^1]: [[...]] where the link contains .pdf, .docx, etc.
    lines = content.split("\n")
    new_lines = []
    attachment_patterns = [".pdf", ".docx", ".xlsx", ".pptx", ".hwp"]
    
    removed_footnote_ids = set()
    
    for line in lines:
        m = re.match(r"^\[\^(\d+)\]:\s*\[\[(.*?)\]\]", line)
        if m:
            fn_id = m.group(1)
            target = m.group(2)
            if any(ext in target.lower() for ext in attachment_patterns):
                removed_footnote_ids.add(fn_id)
                continue
        new_lines.append(line)
        
    # Also remove references in text [^1] if they were removed
    result = "\n".join(new_lines)
    for fn_id in removed_footnote_ids:
        result = result.replace(f"[^{fn_id}]", "")
        
    return result


class MdNode(BaseModel):
    id: int
    type: Literal[
        "frontmatter",
        "h1",
        "h2",
        "h3",
        "h4",
        "paragraph",
        "list",
        "footnote_def",
        "blank",
    ]
    content: str = ""
    parent: int | None = None
    indent: int = 0
    ref: int | None = None


class MdDiff(BaseModel):
    action: Literal["update", "insert_after", "delete", "append_child"]
    id: int | None = None
    parent: int | None = None
    type: str | None = None
    content: str | None = None
    indent: int = 0
    ref: int | None = None


def md_to_json(md: str) -> list[MdNode]:
    lines = md.split("\n")
    nodes: list[MdNode] = []
    next_id = 1
    heading_stack: dict[int, int] = {}
    idx = 0

    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is not None:
            fm_content = "\n".join(lines[1:end_idx])
            nodes.append(MdNode(id=next_id, type="frontmatter", content=fm_content))
            next_id += 1
            idx = end_idx + 1

    def current_parent() -> int | None:
        if not heading_stack:
            return None
        return heading_stack[max(heading_stack.keys())]

    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()

        if stripped == "":
            nodes.append(MdNode(id=next_id, type="blank", parent=current_parent()))
            next_id += 1
            idx += 1
            continue

        heading_match = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            content = heading_match.group(2).strip()
            parent = heading_stack.get(level - 1)
            nodes.append(
                MdNode(
                    id=next_id,
                    type=f"h{level}",
                    content=content,
                    parent=parent,
                )
            )
            heading_stack = {k: v for k, v in heading_stack.items() if k < level}
            heading_stack[level] = next_id
            next_id += 1
            idx += 1
            continue

        list_match = re.match(r"^([ \t]*)(?:-\s+|(\d+)\.\s+)(.*)$", line)
        if list_match:
            leading = list_match.group(1)
            text = list_match.group(3).strip()
            indent = leading.count("\t") + (leading.replace("\t", "").count(" ") // 2)
            nodes.append(
                MdNode(
                    id=next_id,
                    type="list",
                    content=text,
                    parent=current_parent(),
                    indent=indent,
                )
            )
            next_id += 1
            idx += 1
            continue

        footnote_match = re.match(r"^\[\^(\d+)\]:\s*(.*)$", stripped)
        if footnote_match:
            nodes.append(
                MdNode(
                    id=next_id,
                    type="footnote_def",
                    content=footnote_match.group(2).strip(),
                    parent=current_parent(),
                    ref=int(footnote_match.group(1)),
                )
            )
            next_id += 1
            idx += 1
            continue

        nodes.append(
            MdNode(
                id=next_id,
                type="paragraph",
                content=line,
                parent=current_parent(),
            )
        )
        next_id += 1
        idx += 1

    return nodes


def json_to_md(nodes: list[MdNode]) -> str:
    lines: list[str] = []
    for node in nodes:
        if node.type == "frontmatter":
            lines.append(f"---\n{node.content}\n---")
        elif node.type == "h1":
            lines.append(f"# {node.content}")
        elif node.type == "h2":
            lines.append(f"## {node.content}")
        elif node.type == "h3":
            lines.append(f"### {node.content}")
        elif node.type == "h4":
            lines.append(f"#### {node.content}")
        elif node.type == "list":
            indent = "\t" * max(node.indent, 0)
            lines.append(f"{indent}- {node.content}")
        elif node.type == "footnote_def":
            ref = node.ref if node.ref is not None else ""
            lines.append(f"[^{ref}]: {node.content}")
        elif node.type == "paragraph":
            lines.append(node.content)
        elif node.type == "blank":
            lines.append("")
    return "\n".join(lines)


def apply_json_diffs(nodes: list[MdNode], diffs: list[MdDiff]) -> list[MdNode]:
    result = [node.model_copy(deep=True) for node in nodes]
    next_id = (max((node.id for node in result), default=0) + 1)

    def find_index(node_id: int | None) -> int | None:
        if node_id is None:
            return None
        for i, node in enumerate(result):
            if node.id == node_id:
                return i
        return None

    for diff in diffs:
        if diff.action == "update":
            idx = find_index(diff.id)
            if idx is None:
                continue
            if diff.content is not None:
                result[idx].content = diff.content
            if diff.type is not None:
                result[idx].type = diff.type  # type: ignore[assignment]
            if diff.ref is not None:
                result[idx].ref = diff.ref
            result[idx].indent = diff.indent

        elif diff.action == "insert_after":
            idx = find_index(diff.id)
            if idx is None:
                continue
            result.insert(
                idx + 1,
                MdNode(
                    id=next_id,
                    type=(diff.type or "paragraph"),  # type: ignore[arg-type]
                    content=diff.content or "",
                    parent=diff.parent,
                    indent=diff.indent,
                    ref=diff.ref,
                ),
            )
            next_id += 1

        elif diff.action == "delete":
            idx = find_index(diff.id)
            if idx is None:
                continue
            del result[idx]

        elif diff.action == "append_child":
            parent_idx = find_index(diff.parent)
            if parent_idx is None:
                continue
            insert_at = parent_idx + 1
            for i in range(parent_idx + 1, len(result)):
                if result[i].parent == diff.parent:
                    insert_at = i + 1
            result.insert(
                insert_at,
                MdNode(
                    id=next_id,
                    type=(diff.type or "paragraph"),  # type: ignore[arg-type]
                    content=diff.content or "",
                    parent=diff.parent,
                    indent=diff.indent,
                    ref=diff.ref,
                ),
            )
            next_id += 1

    return result


if __name__ == "__main__":
    test_markdown = """---
title: 테스트 위키
author: 나노클로
---

# 인물 소개

## 핵심 성격
- 침착함
	- 하위 항목
1. 분석적 사고

### 상세 설명
이 인물은 위기 상황에서도 침착하게 대응한다.[^1]

[^1]: 내부 관찰 기록 요약
"""

    parsed = md_to_json(test_markdown)
    restored = json_to_md(parsed)

    assert "## 핵심 성격" in restored
    assert "[^1]:" in restored
    assert "\t- 하위 항목" in restored

    print("All tests passed!")
