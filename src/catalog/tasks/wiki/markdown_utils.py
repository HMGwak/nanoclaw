"""Markdown section-based editing utilities."""

from __future__ import annotations

import re
from typing import Literal
from pydantic import BaseModel


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
