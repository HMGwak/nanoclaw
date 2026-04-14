"""
schedule_sync/task.py — Obsidian 일정 쿼리 catalog 진입점.

vault_query.py를 래핑하여 표준 task 인터페이스 제공.

CLI:
    python3 task.py [query_text]
    python3 task.py 주간
    python3 task.py 오늘
    python3 task.py 마감
    python3 task.py 러시아

반환값: Discord 마크다운 형식 텍스트 (stdout)
"""
from __future__ import annotations

import sys
from pathlib import Path

# 패키지 외부에서 직접 실행할 때 경로 보정
_repo_root = Path(__file__).parent.parent.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from src.catalog.tasks.schedule_sync.vault_query import query  # noqa: E402


def run(query_text: str = "") -> str:
    """쿼리 텍스트를 받아 Discord 형식 리포트 반환."""
    return query(query_text.strip())


if __name__ == "__main__":
    text = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "주간"
    print(run(text))
