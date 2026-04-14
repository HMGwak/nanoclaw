"""
vault_query.py — Obsidian vault schedule query module for schedule_sync.

Provides Discord-formatted reports for weekly/daily/project status queries.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

try:
    from .vault_scanner import VaultDocument, CheckboxItem, scan_vault
except ImportError:
    import sys as _sys
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).parent.parent.parent.parent))
    from src.catalog.tasks.schedule_sync.vault_scanner import VaultDocument, CheckboxItem, scan_vault  # type: ignore

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VAULT_ROOT = Path("/Users/planee/Documents/Mywork")
DISCORD_MAX_LEN = 2000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fmt_date(d: date, today: date) -> str:
    """Format date as MM/DD; include year if not current year."""
    if d.year == today.year:
        return d.strftime("%m/%d")
    return d.strftime("%Y/%m/%d")


def _week_range(ref: date, offset_weeks: int = 0) -> tuple[date, date]:
    """Return (monday, sunday) for the week containing ref, shifted by offset_weeks."""
    monday = ref - timedelta(days=ref.weekday()) + timedelta(weeks=offset_weeks)
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _is_completed(doc: VaultDocument) -> bool:
    """True if doc has 완료일 set AND all checkboxes are completed (or no checkboxes)."""
    if doc.완료일 is None:
        return False
    if doc.checkboxes and any(not cb.completed for cb in doc.checkboxes):
        return False
    return True


def _progress(doc: VaultDocument) -> tuple[int, int]:
    """Return (completed_count, total_count) for checkboxes."""
    total = len(doc.checkboxes)
    done = sum(1 for cb in doc.checkboxes if cb.completed)
    return done, total


def _status_label(doc: VaultDocument) -> str:
    if _is_completed(doc):
        return "완료"
    return "진행중"


def _doc_line(doc: VaultDocument, today: date, show_deadline: bool = True) -> str:
    """Format a single document as a Discord bullet line."""
    label = _status_label(doc)
    done, total = _progress(doc)

    parts = [f"• [{label}] {doc.title}"]

    if show_deadline:
        if doc.마감일:
            parts.append(f"— 마감 {_fmt_date(doc.마감일, today)}")
        else:
            parts.append("— 마감일 미정")

    if total > 0 and not _is_completed(doc):
        parts.append(f", 미완료 {total - done}/{total}개")

    return " ".join(parts)


def _truncate(text: str, max_len: int = DISCORD_MAX_LEN) -> str:
    if len(text) <= max_len:
        return text
    cutoff = text.rfind("\n", 0, max_len - 20)
    if cutoff == -1:
        cutoff = max_len - 20
    return text[:cutoff] + "\n\n*(메시지 길이 초과로 일부 생략됨)*"


# ---------------------------------------------------------------------------
# Core query functions
# ---------------------------------------------------------------------------

def get_weekly_report(today: date = None) -> str:
    """이번 주 + 다음 주 업무 현황 리포트 (Discord 메시지 형식)."""
    if today is None:
        today = date.today()

    docs = scan_vault(VAULT_ROOT)

    this_mon, this_sun = _week_range(today, 0)
    next_mon, next_sun = _week_range(today, 1)

    # Categorize documents
    this_week: list[VaultDocument] = []
    next_week: list[VaultDocument] = []
    this_month: list[VaultDocument] = []

    month_start = today.replace(day=1)
    # last day of current month
    if today.month == 12:
        month_end = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
    else:
        month_end = today.replace(month=today.month + 1, day=1) - timedelta(days=1)

    for doc in docs:
        if _is_completed(doc):
            continue
        dl = doc.마감일
        if dl is None:
            continue
        if this_mon <= dl <= this_sun:
            this_week.append(doc)
        elif next_mon <= dl <= next_sun:
            next_week.append(doc)
        elif month_start <= dl <= month_end:
            this_month.append(doc)

    lines: list[str] = [
        f"📅 **주간 업무 현황** ({today.strftime('%Y-%m-%d')} 기준)",
        "",
        f"**이번 주 마감 ({this_mon.strftime('%m/%d')} ~ {this_sun.strftime('%m/%d')})**",
    ]

    if this_week:
        # Include completed docs in this week section (already filtered above — but
        # re-scan to show completed ones too for awareness)
        for doc in this_week:
            lines.append(_doc_line(doc, today))
    else:
        lines.append("• 이번 주 마감 항목 없음")

    lines.append("")
    lines.append(f"**다음 주 마감 ({next_mon.strftime('%m/%d')} ~ {next_sun.strftime('%m/%d')})**")

    if next_week:
        for doc in next_week:
            lines.append(_doc_line(doc, today))
    else:
        lines.append("• 다음 주 마감 항목 없음")

    if this_month:
        lines.append("")
        lines.append("**이번 달 예정**")
        for doc in this_month:
            lines.append(_doc_line(doc, today))

    return _truncate("\n".join(lines))


def get_today_report(today: date = None) -> str:
    """오늘 마감/착수 항목 리포트."""
    if today is None:
        today = date.today()

    docs = scan_vault(VAULT_ROOT)

    due_today: list[VaultDocument] = []
    starting_today: list[VaultDocument] = []

    for doc in docs:
        if doc.마감일 == today:
            due_today.append(doc)
        if doc.착수일 == today:
            starting_today.append(doc)

    lines: list[str] = [
        f"📋 **오늘 업무** ({today.strftime('%Y-%m-%d')})",
        "",
    ]

    lines.append("**오늘 마감**")
    if due_today:
        for doc in due_today:
            lines.append(_doc_line(doc, today, show_deadline=False))
    else:
        lines.append("• 오늘 마감 항목 없음")

    if starting_today:
        lines.append("")
        lines.append("**오늘 착수**")
        for doc in starting_today:
            lines.append(_doc_line(doc, today))

    return _truncate("\n".join(lines))


def get_project_status(keyword: str) -> str:
    """프로젝트명 키워드로 검색해서 현황 리포트."""
    today = date.today()
    docs = scan_vault(VAULT_ROOT)

    keyword_lower = keyword.lower()
    matched = [
        doc for doc in docs
        if keyword_lower in doc.title.lower() or keyword_lower in str(doc.path).lower()
    ]

    if not matched:
        return f"🔍 **'{keyword}' 검색 결과**\n\n• 일치하는 프로젝트 없음"

    lines: list[str] = [
        f"🔍 **'{keyword}' 프로젝트 현황** ({today.strftime('%Y-%m-%d')} 기준)",
        "",
    ]

    for doc in matched:
        label = _status_label(doc)
        done, total = _progress(doc)

        lines.append(f"**{doc.title}**")

        dl_str = _fmt_date(doc.마감일, today) if doc.마감일 else "미정"
        lines.append(f"  마감: {dl_str} | 상태: {label}")

        if doc.접수일:
            lines.append(f"  접수일: {_fmt_date(doc.접수일, today)}")
        if doc.착수일:
            lines.append(f"  착수일: {_fmt_date(doc.착수일, today)}")
        if doc.완료일:
            lines.append(f"  완료일: {_fmt_date(doc.완료일, today)}")

        if total > 0:
            lines.append(f"  체크박스: {done}/{total}개 완료")
            incomplete = [cb for cb in doc.checkboxes if not cb.completed]
            for cb in incomplete[:5]:
                section_prefix = f"[{cb.section}] " if cb.section else ""
                lines.append(f"    • {section_prefix}{cb.content}")
            if len(incomplete) > 5:
                lines.append(f"    ... 외 {len(incomplete) - 5}개")

        lines.append("")

    return _truncate("\n".join(lines))


def get_upcoming_deadlines(days: int = 14) -> str:
    """N일 이내 마감 프로젝트 목록."""
    today = date.today()
    cutoff = today + timedelta(days=days)
    docs = scan_vault(VAULT_ROOT)

    upcoming = [
        doc for doc in docs
        if doc.마감일 is not None and today <= doc.마감일 <= cutoff
    ]
    # Sort by deadline
    upcoming.sort(key=lambda d: d.마감일)

    lines: list[str] = [
        f"⏰ **{days}일 이내 마감** ({today.strftime('%Y-%m-%d')} ~ {cutoff.strftime('%Y-%m-%d')})",
        "",
    ]

    if not upcoming:
        lines.append(f"• {days}일 이내 마감 항목 없음")
    else:
        for doc in upcoming:
            label = _status_label(doc)
            done, total = _progress(doc)
            deadline_str = _fmt_date(doc.마감일, today)
            d_day = (doc.마감일 - today).days

            d_day_str = "오늘" if d_day == 0 else f"D-{d_day}"
            progress_str = f", 미완료 {total - done}/{total}개" if total > 0 and not _is_completed(doc) else ""
            lines.append(f"• [{label}] {doc.title} — {deadline_str} ({d_day_str}){progress_str}")

    return _truncate("\n".join(lines))


# ---------------------------------------------------------------------------
# Natural language query router
# ---------------------------------------------------------------------------

def query(text: str) -> str:
    """자연어 쿼리 라우터 — 키워드 기반으로 적절한 함수 호출."""
    t = text.strip().lower()

    # Deadline queries
    if any(kw in t for kw in ["마감", "deadline", "due"]):
        # extract number if present (e.g. "30일 마감")
        m = re.search(r"(\d+)\s*일", t)
        days = int(m.group(1)) if m else 14
        return get_upcoming_deadlines(days)

    # Next week
    if any(kw in t for kw in ["다음주", "다음 주", "next week"]):
        today = date.today()
        next_mon = _week_range(today, 1)[0]
        # reuse weekly report but anchor to next week's monday
        return get_weekly_report(today=next_mon)

    # Today
    if any(kw in t for kw in ["오늘", "today"]):
        return get_today_report()

    # This week / weekly
    if any(kw in t for kw in ["이번주", "이번 주", "주간", "weekly", "week"]):
        return get_weekly_report()

    # Fallback: project keyword search
    return get_project_status(text)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from src.catalog.tasks.schedule_sync.vault_scanner import scan_vault as _scan_vault  # noqa: F811

    # Patch the module-level scan_vault so functions above use the absolute import
    import src.catalog.tasks.schedule_sync.vault_query as _self
    from src.catalog.tasks.schedule_sync import vault_scanner as _vs
    _self.scan_vault = _vs.scan_vault  # type: ignore[attr-defined]

    if len(sys.argv) > 1:
        query_text = " ".join(sys.argv[1:])
        print(query(query_text))
    else:
        print(get_weekly_report())
