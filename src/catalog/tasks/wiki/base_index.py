"""BaseIndexParser — .base YAML parser and file discovery for Obsidian vaults.

Translates Obsidian Base filter rules (file.folder.contains, file.name.startsWith, etc.)
into Python glob + fnmatch for file discovery without any external Obsidian dependency.
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

import yaml


class BaseIndexParser:
    """Parse Obsidian .base YAML files and discover matching vault files.

    Usage::

        parser = BaseIndexParser(vault_root="~/Documents/Mywork")
        files = parser.discover(
            "index/안전성검토.base",
            view_name="안전성검토",
            filter_pattern="(안전성검토)_*.md",
        )
    """

    def __init__(self, vault_root: Path | str):
        self.vault_root = Path(vault_root).expanduser().resolve()

    # ── Public API ────────────────────────────────────────────────

    def parse(self, base_file: Path | str) -> dict:
        """Parse a .base YAML file and return the raw dict."""
        path = Path(base_file).expanduser()
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def discover(
        self,
        base_file: Path | str,
        view_name: str | None = None,
        filter_pattern: str | None = None,
    ) -> list[Path]:
        """Discover vault files that match the .base filter rules.

        Args:
            base_file: Path to the .base YAML file (absolute or relative to cwd).
            view_name: Name of the view whose filters to use. Uses the first
                       view when None.
            filter_pattern: Additional fnmatch wildcard applied to *filenames*
                            after base filters (e.g. ``"(안전성검토)_*.md"``).

        Returns:
            Sorted list of absolute Path objects for matching .md files.
        """
        data = self.parse(base_file)
        views = data.get("views", [])
        if not views:
            return []

        view = (
            next((v for v in views if v.get("name") == view_name), views[0])
            if view_name
            else views[0]
        )

        rules = self._extract_rules(view.get("filters", {}))
        matched = [
            f
            for f in self.vault_root.rglob("*.md")
            if self._matches(f, rules)
        ]

        if filter_pattern:
            matched = [f for f in matched if fnmatch.fnmatch(f.name, filter_pattern)]

        return sorted(matched)

    # ── Rule extraction ───────────────────────────────────────────

    def _extract_rules(self, filters: dict | str | list) -> list[dict]:
        """Flatten the filter tree into a flat list of rule dicts (AND semantics)."""
        if not filters:
            return []
        if isinstance(filters, str):
            return [self._parse_rule_string(filters)]
        if isinstance(filters, list):
            rules: list[dict] = []
            for item in filters:
                rules.extend(self._parse_filter_item(item))
            return rules
        if "and" in filters:
            rules = []
            for item in filters["and"]:
                rules.extend(self._parse_filter_item(item))
            return rules
        if "or" in filters:
            sub_rules: list[dict] = []
            for item in filters["or"]:
                sub_rules.extend(self._parse_filter_item(item))
            return [{"type": "or", "rules": sub_rules}]
        return []

    def _parse_filter_item(self, item) -> list[dict]:
        """Parse one item in a filter list (string or nested and/or dict)."""
        if isinstance(item, str):
            return [self._parse_rule_string(item)]
        if isinstance(item, dict):
            if "and" in item:
                rules: list[dict] = []
                for sub in item["and"]:
                    rules.extend(self._parse_filter_item(sub))
                return rules
            if "or" in item:
                sub_rules: list[dict] = []
                for sub in item["or"]:
                    sub_rules.extend(self._parse_filter_item(sub))
                return [{"type": "or", "rules": sub_rules}]
        return []

    _RULE_PATTERNS: list[tuple[re.Pattern, str]] = [
        (re.compile(r'file\.folder\.contains\("(.+?)"\)'), "folder_contains"),
        (re.compile(r'file\.name\.startsWith\("(.+?)"\)'), "name_startswith"),
        (re.compile(r'file\.name\.endsWith\("(.+?)"\)'), "name_endswith"),
        (re.compile(r'file\.name\.contains\("(.+?)"\)'), "name_contains"),
        (re.compile(r'tags\.contains\("(.+?)"\)'), "tags_contains"),
    ]

    def _parse_rule_string(self, rule: str) -> dict:
        """Parse a filter rule string like ``file.folder.contains("X")``."""
        rule = rule.strip()
        for pattern, rtype in self._RULE_PATTERNS:
            m = pattern.match(rule)
            if m:
                return {"type": rtype, "value": m.group(1)}
        return {"type": "unknown", "raw": rule}

    # ── Rule evaluation ───────────────────────────────────────────

    def _matches(self, file_path: Path, rules: list[dict]) -> bool:
        """Return True if file_path satisfies ALL rules (top-level AND)."""
        for rule in rules:
            if not self._match_rule(file_path, rule):
                return False
        return True

    def _match_rule(self, file_path: Path, rule: dict) -> bool:
        """Evaluate a single rule against a file path."""
        rtype = rule["type"]

        if rtype == "folder_contains":
            try:
                parent_rel = str(file_path.parent.relative_to(self.vault_root))
            except ValueError:
                parent_rel = str(file_path.parent)
            return rule["value"] in parent_rel

        if rtype == "name_startswith":
            return file_path.name.startswith(rule["value"])

        if rtype == "name_endswith":
            return file_path.stem.endswith(rule["value"])

        if rtype == "name_contains":
            return rule["value"] in file_path.name

        if rtype == "tags_contains":
            # Requires frontmatter parsing — skipped; treated as pass-through
            return True

        if rtype == "or":
            return any(self._match_rule(file_path, sub) for sub in rule["rules"])

        # unknown rules are ignored (pass-through)
        return True
