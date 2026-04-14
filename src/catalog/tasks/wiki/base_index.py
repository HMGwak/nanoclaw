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
        self._frontmatter_cache: dict[Path, dict] = {}

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
        filter_expr: str | None = None,
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
        top_rules = self._extract_rules(data.get("filters", {}))

        candidate_views: list[dict]
        if view_name:
            view = next((v for v in views if v.get("name") == view_name), None)
            candidate_views = [view] if view else []
        else:
            candidate_views = list(views)

        matched_map: dict[str, Path] = {}

        if candidate_views:
            for view in candidate_views:
                view_rules = (
                    self._extract_rules(view.get("filters", {})) if view else []
                )
                rules = top_rules + view_rules
                for file_path in self.vault_root.rglob("*.md"):
                    if self._matches(file_path, rules):
                        matched_map[str(file_path)] = file_path
        else:
            for file_path in self.vault_root.rglob("*.md"):
                if self._matches(file_path, top_rules):
                    matched_map[str(file_path)] = file_path

        matched = sorted(matched_map.values())

        if filter_pattern:
            matched = [f for f in matched if fnmatch.fnmatch(f.name, filter_pattern)]

        if filter_expr:
            expr = _FrontmatterExprParser(filter_expr).parse()
            matched = [f for f in matched if self._match_frontmatter_expr(f, expr)]

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

    def _match_frontmatter_expr(self, file_path: Path, expr: dict) -> bool:
        rtype = expr["type"]
        if rtype == "eq":
            frontmatter = self._read_frontmatter(file_path)
            value = frontmatter.get(expr["field"])
            expected = expr["value"]
            if isinstance(value, list):
                return any(str(item) == expected for item in value)
            if value is None:
                return False
            return str(value) == expected
        if rtype == "and":
            return all(
                self._match_frontmatter_expr(file_path, sub) for sub in expr["items"]
            )
        if rtype == "or":
            return any(
                self._match_frontmatter_expr(file_path, sub) for sub in expr["items"]
            )
        return True

    def _read_frontmatter(self, file_path: Path) -> dict:
        cached = self._frontmatter_cache.get(file_path)
        if cached is not None:
            return cached

        try:
            text = file_path.read_text(encoding="utf-8")
        except Exception:
            self._frontmatter_cache[file_path] = {}
            return {}

        if not text.startswith("---\n"):
            self._frontmatter_cache[file_path] = {}
            return {}

        end = text.find("\n---", 4)
        if end == -1:
            self._frontmatter_cache[file_path] = {}
            return {}

        raw = text[4:end]
        try:
            data = yaml.safe_load(raw) or {}
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        self._frontmatter_cache[file_path] = data
        return data


class _FrontmatterExprParser:
    _TOKEN_RE = re.compile(
        r'\s*(?:(?P<lpar>\()|(?P<rpar>\))|(?P<and>\+)|(?P<or>\|)|(?P<eq>=)|(?P<ident>[A-Za-z0-9_가-힣]+)|(?P<string>"(?:[^"\\]|\\.)*"))'
    )

    def __init__(self, text: str):
        self._tokens = self._tokenize(text)
        self._index = 0

    def parse(self) -> dict:
        expr = self._parse_or()
        if self._index != len(self._tokens):
            raise ValueError(f"Unexpected token: {self._tokens[self._index]}")
        return expr

    def _tokenize(self, text: str) -> list[tuple[str, str]]:
        pos = 0
        tokens: list[tuple[str, str]] = []
        while pos < len(text):
            match = self._TOKEN_RE.match(text, pos)
            if not match:
                raise ValueError(f"Invalid filter syntax near: {text[pos:]}")
            pos = match.end()
            kind = match.lastgroup
            value = match.group(kind) if kind else ""
            if kind:
                tokens.append((kind, value))
        return tokens

    def _peek(self) -> tuple[str, str] | None:
        if self._index >= len(self._tokens):
            return None
        return self._tokens[self._index]

    def _consume(self, expected: str | None = None) -> tuple[str, str]:
        token = self._peek()
        if token is None:
            raise ValueError("Unexpected end of filter expression")
        if expected and token[0] != expected:
            raise ValueError(f"Expected {expected}, got {token[0]}")
        self._index += 1
        return token

    def _parse_or(self) -> dict:
        items = [self._parse_and()]
        token = self._peek()
        while token and token[0] == "or":
            self._consume("or")
            items.append(self._parse_and())
            token = self._peek()
        if len(items) == 1:
            return items[0]
        return {"type": "or", "items": items}

    def _parse_and(self) -> dict:
        items = [self._parse_primary()]
        token = self._peek()
        while token and token[0] == "and":
            self._consume("and")
            items.append(self._parse_primary())
            token = self._peek()
        if len(items) == 1:
            return items[0]
        return {"type": "and", "items": items}

    def _parse_primary(self) -> dict:
        token = self._peek()
        if token is None:
            raise ValueError("Unexpected end of filter expression")
        if token[0] == "lpar":
            self._consume("lpar")
            expr = self._parse_or()
            self._consume("rpar")
            return expr
        return self._parse_comparison()

    def _parse_comparison(self) -> dict:
        field = self._consume("ident")[1]
        self._consume("eq")
        raw = self._consume("string")[1]
        value = bytes(raw[1:-1], "utf-8").decode("unicode_escape")
        return {"type": "eq", "field": field, "value": value}
