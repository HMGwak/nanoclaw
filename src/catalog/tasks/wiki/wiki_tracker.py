"""
WikiTracker — SQLite-backed work log and SHA256 content hash tracking.

DB file: wiki_tracker.db (same directory as this module)
"""

import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "wiki_tracker.db"

DDL = """
CREATE TABLE IF NOT EXISTS processed_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    run_id TEXT NOT NULL,
    wiki_output TEXT,
    processed_at TEXT NOT NULL,
    UNIQUE(doc_path, run_id)
);

CREATE TABLE IF NOT EXISTS wiki_runs (
    run_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    base_path TEXT,
    filter_pattern TEXT,
    input_count INTEGER,
    new_count INTEGER,
    changed_count INTEGER,
    output_count INTEGER,
    output_path TEXT,
    status TEXT DEFAULT 'running',
    started_at TEXT NOT NULL,
    completed_at TEXT
);
"""


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class WikiTracker:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._conn = sqlite3.connect(str(db_path))
        self._conn.executescript(DDL)
        self._conn.commit()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify_docs(
        self, paths: list[Path]
    ) -> tuple[list[Path], list[Path], list[Path]]:
        """Classify paths into (new, changed, unchanged) vs latest run hashes."""
        new: list[Path] = []
        changed: list[Path] = []
        unchanged: list[Path] = []

        for p in paths:
            current_hash = _sha256(p)
            stored_hash = self.get_latest_hash(str(p))
            if stored_hash is None:
                new.append(p)
            elif stored_hash != current_hash:
                changed.append(p)
            else:
                unchanged.append(p)

        return new, changed, unchanged

    def record_run(
        self,
        run_id: str,
        domain: str,
        base_path: str | None,
        filter_pattern: str | None,
        docs: list[Path],
        outputs: dict[str, str],  # doc_path -> wiki_output
    ) -> None:
        """Insert a wiki_runs record and processed_docs rows for each doc."""
        new, changed, _ = self.classify_docs(docs)
        now = _now()

        self._conn.execute(
            """
            INSERT OR REPLACE INTO wiki_runs
                (run_id, domain, base_path, filter_pattern,
                 input_count, new_count, changed_count, output_count,
                 status, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
            """,
            (
                run_id,
                domain,
                base_path,
                filter_pattern,
                len(docs),
                len(new),
                len(changed),
                len(outputs),
                now,
            ),
        )

        for p in docs:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO processed_docs
                    (doc_path, content_hash, run_id, wiki_output, processed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    str(p),
                    _sha256(p),
                    run_id,
                    outputs.get(str(p)),
                    now,
                ),
            )

        self._conn.commit()

    def complete_run(self, run_id: str, output_count: int, output_path: str | None = None) -> None:
        """Mark a run as completed and record final output_count + output_path."""
        self._conn.execute(
            """
            UPDATE wiki_runs
            SET status = 'completed', completed_at = ?, output_count = ?, output_path = ?
            WHERE run_id = ?
            """,
            (_now(), output_count, output_path, run_id),
        )
        self._conn.commit()

    def get_latest_wiki_path(self, domain: str) -> Path | None:
        """Return the output_path of the latest completed run for a domain."""
        row = self._conn.execute(
            """
            SELECT output_path FROM wiki_runs
            WHERE domain = ? AND status = 'completed' AND output_path IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT 1
            """,
            (domain,),
        ).fetchone()
        if row and row[0]:
            p = Path(row[0])
            return p if p.exists() else None
        return None

    def get_latest_hash(self, doc_path: str) -> str | None:
        """Return the most recent content hash for doc_path, or None."""
        row = self._conn.execute(
            """
            SELECT content_hash FROM processed_docs
            WHERE doc_path = ?
            ORDER BY processed_at DESC
            LIMIT 1
            """,
            (doc_path,),
        ).fetchone()
        return row[0] if row else None

    def close(self) -> None:
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# ---------------------------------------------------------------------------
# Quick smoke-test (run directly: python wiki_tracker.py)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as tmp:
        # Create test files
        f1 = Path(tmp) / "doc_a.txt"
        f2 = Path(tmp) / "doc_b.txt"
        f1.write_text("hello world")
        f2.write_text("foo bar")

        db_file = Path(tmp) / "test_tracker.db"
        tracker = WikiTracker(db_path=db_file)

        # First pass — both are new
        new, changed, unchanged = tracker.classify_docs([f1, f2])
        assert new == [f1, f2], f"Expected both new, got new={new}"
        assert changed == []
        assert unchanged == []
        print("PASS: first classify — both new")

        # Record run
        run_id = str(uuid.uuid4())
        tracker.record_run(
            run_id=run_id,
            domain="test",
            base_path=tmp,
            filter_pattern="*.txt",
            docs=[f1, f2],
            outputs={str(f1): "wiki output A", str(f2): "wiki output B"},
        )
        tracker.complete_run(run_id, output_count=2)

        # Second pass — no changes
        new, changed, unchanged = tracker.classify_docs([f1, f2])
        assert new == []
        assert changed == []
        assert unchanged == [f1, f2], f"Expected both unchanged, got {unchanged}"
        print("PASS: second classify — both unchanged")

        # Modify f1
        f1.write_text("hello world UPDATED")

        new, changed, unchanged = tracker.classify_docs([f1, f2])
        assert new == []
        assert changed == [f1], f"Expected f1 changed, got {changed}"
        assert unchanged == [f2]
        print("PASS: third classify — f1 changed, f2 unchanged")

        # get_latest_hash
        h = tracker.get_latest_hash(str(f2))
        assert h == hashlib.sha256(b"foo bar").hexdigest()
        print("PASS: get_latest_hash correct")

        tracker.close()
        print("\nAll tests passed.")
