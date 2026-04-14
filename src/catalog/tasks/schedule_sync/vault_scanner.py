"""
vault_scanner.py — Obsidian vault scanner for schedule_sync.

Scans 1. Project/ and 2. Area of responsibility/ folders,
parses frontmatter dates and checkboxes, ensures block IDs on
checkbox lines, and generates a _sync_hub.md file.
"""

from __future__ import annotations

import random
import re
import string
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional
import sys

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class CheckboxItem:
    content: str          # checkbox text (^blockid 제외)
    completed: bool       # [x] = True
    block_id: str         # ^a1b2c3 (없으면 생성 후 삽입)
    line_number: int      # 원본 파일에서의 줄 번호 (0-indexed)
    section: str          # 상위 헤딩 (없으면 "")


@dataclass
class VaultDocument:
    path: Path
    title: str
    접수일: Optional[date]
    착수일: Optional[date]
    마감일: Optional[date]
    완료일: Optional[date]
    checkboxes: list[CheckboxItem] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCAN_FOLDERS = ["1. Project", "2. Area of responsibility"]
EXCLUDE_DIRS = {"4. Archive", "3. Resource", "Templates", "Excalidraw", "attachedFiles"}

_BLOCK_ID_RE = re.compile(r'\s\^([a-z0-9]{6})\s*$')
_CHECKBOX_RE = re.compile(r'^(\s*)-\s+\[([ xX])\]\s+(.*?)$')
_HEADING_RE = re.compile(r'^(#{1,6})\s+(.*)')
_FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---\s*\n', re.DOTALL)
_DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')

_BLOCK_CHARS = string.ascii_lowercase + string.digits


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_block_id() -> str:
    return ''.join(random.choices(_BLOCK_CHARS, k=6))


def _parse_date_value(raw) -> Optional[date]:
    """Parse a YAML value that may be a string, date object, or list."""
    if raw is None:
        return None
    # pyyaml may return a datetime.date directly
    if isinstance(raw, date):
        return raw
    # list — take first element
    if isinstance(raw, list):
        if not raw:
            return None
        raw = raw[0]
        if isinstance(raw, date):
            return raw
    # string — extract YYYY-MM-DD
    raw_str = str(raw).strip()
    m = _DATE_RE.search(raw_str)
    if m:
        try:
            parts = m.group(0).split('-')
            return date(int(parts[0]), int(parts[1]), int(parts[2]))
        except (ValueError, IndexError):
            return None
    return None


def _parse_frontmatter(text: str) -> dict:
    """Extract frontmatter as a dict. Tries pyyaml first, falls back to regex."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    yaml_block = m.group(1)
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(yaml_block)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass
    # minimal fallback: key: value lines
    result: dict = {}
    for line in yaml_block.splitlines():
        if ':' in line:
            k, _, v = line.partition(':')
            result[k.strip()] = v.strip()
    return result


def _strip_frontmatter(text: str) -> tuple[str, int]:
    """Return (body_text, body_start_line)."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return text, 0
    body = text[m.end():]
    start_line = m.group(0).count('\n')
    return body, start_line


# ---------------------------------------------------------------------------
# Core parsing
# ---------------------------------------------------------------------------

def parse_document(path: Path) -> Optional[VaultDocument]:
    """Parse a single .md file into a VaultDocument. Returns None on failure."""
    try:
        text = path.read_text(encoding='utf-8')
    except Exception as e:
        print(f"[skip] read error {path}: {e}", file=sys.stderr)
        return None

    try:
        fm = _parse_frontmatter(text)
        body, body_start = _strip_frontmatter(text)

        doc = VaultDocument(
            path=path,
            title=path.stem,
            접수일=_parse_date_value(fm.get('접수일')),
            착수일=_parse_date_value(fm.get('착수일')),
            마감일=_parse_date_value(fm.get('마감일')),
            완료일=_parse_date_value(fm.get('완료일')),
        )

        current_section = ""
        lines = body.splitlines()
        for i, line in enumerate(lines):
            # track current heading
            hm = _HEADING_RE.match(line)
            if hm:
                # strip wikilink brackets from section title
                current_section = re.sub(r'\[\[|\]\]', '', hm.group(2)).strip()
                continue

            cbm = _CHECKBOX_RE.match(line)
            if not cbm:
                continue

            completed = cbm.group(2).lower() == 'x'
            raw_content = cbm.group(3)

            # extract existing block id from end of line
            bid_match = _BLOCK_ID_RE.search(raw_content)
            if bid_match:
                block_id = bid_match.group(1)
                content = raw_content[:bid_match.start()].rstrip()
            else:
                block_id = ""
                content = raw_content.rstrip()

            doc.checkboxes.append(CheckboxItem(
                content=content,
                completed=completed,
                block_id=block_id,
                line_number=body_start + i,
                section=current_section,
            ))

        return doc

    except Exception as e:
        print(f"[skip] parse error {path}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Block ID ensurance
# ---------------------------------------------------------------------------

def ensure_block_ids(doc: VaultDocument, dry_run: bool = False) -> bool:
    """
    Assign block IDs to checkboxes that lack them and write back to the file.
    Returns True if the file was (or would be) modified.
    """
    items_without_id = [cb for cb in doc.checkboxes if not cb.block_id]
    if not items_without_id:
        return False

    # read current lines
    try:
        lines = doc.path.read_text(encoding='utf-8').splitlines(keepends=True)
    except Exception as e:
        raise RuntimeError(f"Cannot read {doc.path}: {e}") from e

    modified = False
    for cb in items_without_id:
        ln = cb.line_number
        if ln >= len(lines):
            continue
        new_id = _generate_block_id()
        # ensure uniqueness within this file
        existing_ids = {c.block_id for c in doc.checkboxes if c.block_id}
        while new_id in existing_ids:
            new_id = _generate_block_id()

        cb.block_id = new_id
        existing_ids.add(new_id)

        original = lines[ln]
        # append before trailing newline
        stripped = original.rstrip('\n')
        eol = original[len(stripped):]
        lines[ln] = f"{stripped} ^{new_id}{eol}"
        modified = True

    if modified and not dry_run:
        try:
            doc.path.write_text(''.join(lines), encoding='utf-8')
        except Exception as e:
            raise RuntimeError(f"Cannot write {doc.path}: {e}") from e

    return modified


# ---------------------------------------------------------------------------
# Vault scan
# ---------------------------------------------------------------------------

def scan_vault(vault_root: Path) -> list[VaultDocument]:
    """
    Scan SCAN_FOLDERS under vault_root.
    Include documents that have 마감일 OR at least one incomplete checkbox.
    """
    docs: list[VaultDocument] = []

    for folder_name in SCAN_FOLDERS:
        folder = vault_root / folder_name
        if not folder.exists():
            continue
        for md_path in folder.rglob('*.md'):
            # exclude any path component that is in EXCLUDE_DIRS
            parts = set(md_path.relative_to(vault_root).parts[:-1])
            if parts & EXCLUDE_DIRS:
                continue

            doc = parse_document(md_path)
            if doc is None:
                continue

            has_deadline = doc.마감일 is not None
            has_open_checkbox = any(not cb.completed for cb in doc.checkboxes)

            if has_deadline or has_open_checkbox:
                docs.append(doc)

    docs.sort(key=lambda d: (d.마감일 or date.max, d.title))
    return docs


# ---------------------------------------------------------------------------
# Hub content generation
# ---------------------------------------------------------------------------

def generate_hub_content(docs: list[VaultDocument]) -> str:
    """Generate markdown content for _sync_hub.md."""
    from datetime import datetime, timezone

    now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    lines: list[str] = [
        "<!-- _sync_hub.md — auto-generated, do not edit manually -->",
        f"<!-- last_updated: {now_iso} -->",
        "",
    ]

    for doc in docs:
        deadline_str = doc.마감일.strftime('%Y-%m-%d') if doc.마감일 else '미정'
        lines.append(f"## {doc.title} | 마감: {deadline_str} <!-- ms_cal: -->")

        for cb in doc.checkboxes:
            check = 'x' if cb.completed else ' '
            bid = cb.block_id or _generate_block_id()
            lines.append(f"- [{check}] {cb.content} ^{bid} <!-- ms_todo: -->")

        lines.append("")

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    vault = Path("/Users/planee/Documents/Mywork")

    print(f"Scanning vault: {vault}")
    docs = scan_vault(vault)
    print(f"Found {len(docs)} documents")

    for doc in docs[:5]:
        print(f"  {doc.title}: 마감={doc.마감일}, checkboxes={len(doc.checkboxes)}")

    if not dry_run:
        print("\nEnsuring block IDs...")
        modified_count = 0
        for doc in docs:
            if ensure_block_ids(doc, dry_run=False):
                modified_count += 1
        print(f"  Modified {modified_count} files")

        hub_path = vault / "_sync_hub.md"
        hub_content = generate_hub_content(docs)
        hub_path.write_text(hub_content, encoding='utf-8')
        print(f"\nHub written: {hub_path}")
        print(f"  Lines: {hub_content.count(chr(10))}")
    else:
        print("\n[dry-run] Skipping file modifications.")
        print("\n--- Hub preview (first 30 lines) ---")
        hub_content = generate_hub_content(docs)
        for line in hub_content.splitlines()[:30]:
            print(line)
