"""
Bridge module: exposes WikiTask to the engine's task loader.
The engine adds its own directory to sys.path and imports 'wiki_task.WikiTask'.
"""
import sys
from pathlib import Path

# Add src/ to path so catalog.tasks.wiki.task can be found
_src_dir = str(Path(__file__).parent.parent.parent.parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from catalog.tasks.wiki.task import WikiTask  # noqa: F401

__all__ = ["WikiTask"]
