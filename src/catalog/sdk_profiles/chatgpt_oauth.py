"""ChatGPT OAuth client using ~/.codex/auth.json tokens.

Reusable module for all Python agents in the NanoClaw catalog.
Does not require OPENAI_API_KEY — uses OAuth tokens from codex auth.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger(__name__)

_AUTH_PATH = Path.home() / ".codex" / "auth.json"
_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_BASE_URL = "https://chatgpt.com/backend-api/codex/responses"
_REFRESH_URL = "https://auth.openai.com/oauth/token"


def _decode_jwt_exp(token: str) -> int | None:
    """Decode exp claim from JWT without verifying signature."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        # Add padding
        payload += "=" * (4 - len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("exp")
    except Exception:
        return None


def _extract_json(text: str) -> str:
    """Extract JSON object from LLM response text."""
    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


class ChatGPTClient:
    """OpenAI API client using ChatGPT OAuth from ~/.codex/auth.json."""

    AUTH_PATH = _AUTH_PATH
    CLIENT_ID = _CLIENT_ID
    BASE_URL = _BASE_URL
    REFRESH_URL = _REFRESH_URL

    def __init__(self, model: str = "gpt-5.4"):
        self.model = model
        self._auth: dict[str, Any] = {}
        self._load_auth()

    # ── Auth ─────────────────────────────────────────────────────

    def _load_auth(self) -> None:
        """Load tokens from auth.json."""
        self._auth = json.loads(self.AUTH_PATH.read_text())

    def _save_auth(self) -> None:
        """Persist updated tokens to auth.json."""
        self.AUTH_PATH.write_text(json.dumps(self._auth, indent=2))

    def _refresh_if_needed(self) -> None:
        """Check token expiry; refresh and persist if within 5 min of expiry."""
        access_token = self._auth.get("tokens", {}).get("access_token", "")
        exp = _decode_jwt_exp(access_token)
        if exp is not None:
            remaining = exp - time.time()
            if remaining > 300:
                return  # still valid
            logger.info("Token expires in %.0fs, refreshing", remaining)
        else:
            logger.debug("Could not decode JWT exp; attempting refresh")

        refresh_token = self._auth.get("tokens", {}).get("refresh_token", "")
        resp = requests.post(
            self.REFRESH_URL,
            json={
                "client_id": self.CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            timeout=30,
        )
        resp.raise_for_status()
        new_tokens = resp.json()
        # Merge new tokens into stored auth
        self._auth.setdefault("tokens", {}).update(new_tokens)
        self._save_auth()
        logger.info("Token refreshed successfully")

    def _headers(self) -> dict[str, str]:
        tokens = self._auth.get("tokens", {})
        return {
            "Authorization": f"Bearer {tokens['access_token']}",
            "ChatGPT-Account-ID": tokens.get("account_id", ""),
            "Content-Type": "application/json",
        }

    # ── Generation ────────────────────────────────────────────────

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        """Call ChatGPT backend API with streaming; return complete text.

        Retries on 429 with exponential backoff (up to 5 attempts).
        """
        self._refresh_if_needed()

        max_retries = 5
        for attempt in range(max_retries + 1):
            try:
                resp = requests.post(
                    self.BASE_URL,
                    headers=self._headers(),
                    json={
                        "model": self.model,
                        "instructions": system_prompt,
                        "input": [{"role": "user", "content": user_prompt}],
                        "store": False,
                        "stream": True,
                    },
                    stream=True,
                    timeout=120,
                )
                if resp.status_code == 429:
                    if attempt >= max_retries:
                        resp.raise_for_status()
                    delay = min(2 ** attempt, 16)
                    logger.warning(
                        "Rate limited (429), retry %d/%d after %ds",
                        attempt + 1,
                        max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                resp.raise_for_status()
                return self._parse_sse_stream(resp)
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 429:
                    if attempt >= max_retries:
                        raise
                    delay = min(2 ** attempt, 16)
                    logger.warning(
                        "Rate limited (429), retry %d/%d after %ds",
                        attempt + 1,
                        max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise

        raise RuntimeError("generate() exhausted retries")

    def _parse_sse_stream(self, resp: requests.Response) -> str:
        """Parse SSE stream and collect response.output_text.delta events."""
        chunks: list[str] = []
        for raw_line in resp.iter_lines():
            if not raw_line:
                continue
            if isinstance(raw_line, bytes):
                line = raw_line.decode("utf-8")
            else:
                line = raw_line
            if not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str == "[DONE]":
                break
            try:
                event = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            # Collect output_text delta events
            if event.get("type") == "response.output_text.delta":
                delta = event.get("delta", "")
                if delta:
                    chunks.append(delta)
        return "".join(chunks)

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict:
        """Generate and parse JSON response."""
        raw = self.generate(system_prompt, user_prompt)
        return json.loads(_extract_json(raw))
