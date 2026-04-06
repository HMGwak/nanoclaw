"""ChatGPT OAuth client using ~/.codex/auth.json tokens + openai SDK.

Reusable module for all Python agents in the NanoClaw catalog.
Does not require OPENAI_API_KEY — uses OAuth tokens from codex auth.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from pathlib import Path
from typing import Any

import openai
import requests

logger = logging.getLogger(__name__)

_AUTH_PATH = Path.home() / ".codex" / "auth.json"
_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_BASE_URL = "https://chatgpt.com/backend-api/codex"
_REFRESH_URL = "https://auth.openai.com/oauth/token"


def _decode_jwt_exp(token: str) -> int | None:
    """Decode exp claim from JWT without verifying signature."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        payload += "=" * (4 - len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("exp")
    except Exception:
        return None


class ChatGPTClient:
    """OpenAI API client using ChatGPT OAuth from ~/.codex/auth.json.

    Uses the openai SDK with custom base_url and OAuth bearer token.
    Streaming is mandatory for the ChatGPT backend API.
    """

    AUTH_PATH = _AUTH_PATH
    CLIENT_ID = _CLIENT_ID
    BASE_URL = _BASE_URL
    REFRESH_URL = _REFRESH_URL

    def __init__(self, model: str = "gpt-5.4"):
        self.model = model
        self._auth: dict[str, Any] = {}
        self._load_auth()
        self._client = self._build_client()

    # ── Auth ─────────────────────────────────────────────────────

    def _load_auth(self) -> None:
        self._auth = json.loads(self.AUTH_PATH.read_text())

    def _save_auth(self) -> None:
        self.AUTH_PATH.write_text(json.dumps(self._auth, indent=2))

    def _tokens(self) -> dict[str, Any]:
        return self._auth.get("tokens", {})

    def _build_client(self) -> openai.OpenAI:
        tokens = self._tokens()
        return openai.OpenAI(
            api_key=tokens["access_token"],
            base_url=self.BASE_URL,
            default_headers={"ChatGPT-Account-ID": tokens.get("account_id", "")},
        )

    def _refresh_if_needed(self) -> None:
        """Check token expiry; refresh and rebuild client if within 5 min."""
        access_token = self._tokens().get("access_token", "")
        exp = _decode_jwt_exp(access_token)
        if exp is not None and (exp - time.time()) > 300:
            return

        logger.info("Token expired or expiring, refreshing")
        refresh_token = self._tokens().get("refresh_token", "")
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
        self._auth.setdefault("tokens", {}).update(resp.json())
        self._save_auth()
        self._client = self._build_client()
        logger.info("Token refreshed successfully")

    # ── Generation ────────────────────────────────────────────────

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        """Call ChatGPT backend API via openai SDK streaming.

        Retries on 429 with exponential backoff (up to 5 attempts).
        """
        self._refresh_if_needed()

        max_retries = 5
        for attempt in range(max_retries + 1):
            try:
                stream = self._client.responses.create(
                    model=self.model,
                    instructions=system_prompt,
                    input=[{"role": "user", "content": user_prompt}],
                    store=False,
                    stream=True,
                )
                chunks: list[str] = []
                for event in stream:
                    if hasattr(event, "type") and event.type == "response.output_text.delta":
                        chunks.append(event.delta)
                    elif hasattr(event, "type") and event.type == "response.completed":
                        break
                return "".join(chunks)
            except openai.RateLimitError:
                if attempt >= max_retries:
                    raise
                delay = min(2 ** attempt, 16)
                logger.warning("Rate limited (429), retry %d/%d after %ds", attempt + 1, max_retries, delay)
                time.sleep(delay)
            except openai.InternalServerError:
                if attempt >= 2:
                    raise
                logger.warning("Server error, retry %d/3", attempt + 1)
            except (openai.AuthenticationError, openai.PermissionDeniedError):
                raise

        raise RuntimeError("generate() exhausted retries")
