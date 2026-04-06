"""Shared JSON extraction + pydantic validation utilities."""

from __future__ import annotations

import json
import logging
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


def extract_json(text: str) -> str:
    """Extract JSON object or array from LLM response text.

    Tries in order:
    1. Markdown code fence (```json ... ``` or ``` ... ```)
    2. Raw JSON object ({...})
    3. Raw JSON array ([...])
    4. Returns original text as fallback
    """
    # Try code fence
    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()

    # Find first occurrence of both { and [
    obj_start = text.find("{")
    arr_start = text.find("[")

    # Pick whichever appears first in the text
    if arr_start != -1 and (obj_start == -1 or arr_start < obj_start):
        # Array comes first — extract [...]
        end = text.rfind("]")
        if end != -1 and end > arr_start:
            return text[arr_start : end + 1]

    if obj_start != -1:
        end = text.rfind("}")
        if end != -1 and end > obj_start:
            return text[obj_start : end + 1]

    # Fallback: try array even if object start was earlier
    if arr_start != -1:
        end = text.rfind("]")
        if end != -1 and end > arr_start:
            return text[arr_start : end + 1]

    return text


def parse_validated(text: str, model: type[T]) -> T:
    """Extract JSON from LLM response and validate with pydantic model.

    Raises ValueError if extraction or validation fails.
    """
    raw = extract_json(text)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON parse failed: {exc}") from exc

    try:
        return model.model_validate(parsed)
    except ValidationError as exc:
        raise ValueError(f"Pydantic validation failed: {exc}") from exc


def parse_validated_list(text: str, item_model: type[T]) -> list[T]:
    """Extract JSON array and validate each item with pydantic model.

    Raises ValueError if extraction or validation fails.
    """
    raw = extract_json(text)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON parse failed: {exc}") from exc

    if not isinstance(parsed, list):
        raise ValueError(f"Expected JSON array, got {type(parsed).__name__}")

    items: list[T] = []
    for i, item in enumerate(parsed):
        try:
            items.append(item_model.model_validate(item))
        except ValidationError as exc:
            logger.warning("Item #%d validation failed, skipping: %s", i, exc)
            continue

    return items


def try_parse_validated(text: str, model: type[T], default: T | None = None) -> T | None:
    """Like parse_validated but returns default on failure instead of raising."""
    try:
        return parse_validated(text, model)
    except ValueError as exc:
        logger.warning("Validated parse failed: %s", exc)
        return default
