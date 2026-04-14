"""
Microsoft Graph API authentication using MSAL Device Code Flow.
Supports company M365 accounts (Delegated permissions).

Usage:
    from msgraph_auth import GraphAuth
    auth = GraphAuth.from_config()
    token = auth.get_token()
    headers = auth.get_headers()
"""
import json
import os
from pathlib import Path
from typing import Optional

import msal

SCOPES = ["Tasks.ReadWrite", "Calendars.ReadWrite", "User.Read"]
TOKEN_CACHE_PATH = Path.home() / ".config" / "nanoclaw" / "msgraph-token.json"
CONFIG_PATH = Path.home() / ".config" / "nanoclaw" / "msgraph-config.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphAuth:
    def __init__(self, client_id: str, tenant_id: str):
        self.client_id = client_id
        self.tenant_id = tenant_id
        self._cache = msal.SerializableTokenCache()
        self._load_cache()
        self._app = msal.PublicClientApplication(
            client_id=client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            token_cache=self._cache,
        )

    @classmethod
    def from_config(cls) -> "GraphAuth":
        """Load credentials from ~/.config/nanoclaw/msgraph-config.json"""
        if not CONFIG_PATH.exists():
            raise FileNotFoundError(
                f"Config not found: {CONFIG_PATH}\n"
                f"Create it with:\n"
                f'{{"client_id": "YOUR_APP_CLIENT_ID", "tenant_id": "YOUR_TENANT_ID"}}'
            )
        config = json.loads(CONFIG_PATH.read_text())
        client_id = config.get("client_id") or os.environ.get("MSGRAPH_CLIENT_ID")
        tenant_id = config.get("tenant_id") or os.environ.get("MSGRAPH_TENANT_ID")
        if not client_id or not tenant_id:
            raise ValueError("client_id and tenant_id are required in config or env")
        return cls(client_id=client_id, tenant_id=tenant_id)

    def _load_cache(self):
        if TOKEN_CACHE_PATH.exists():
            self._cache.deserialize(TOKEN_CACHE_PATH.read_text())

    def _save_cache(self):
        if self._cache.has_state_changed:
            TOKEN_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            TOKEN_CACHE_PATH.write_text(self._cache.serialize())

    def get_token(self) -> str:
        """Get access token, refreshing silently if possible, or via Device Code Flow."""
        accounts = self._app.get_accounts()
        result = None

        if accounts:
            result = self._app.acquire_token_silent(SCOPES, account=accounts[0])

        if not result:
            result = self._device_code_flow()

        if "access_token" not in result:
            error = result.get("error_description") or result.get("error", "unknown")
            raise RuntimeError(f"Failed to acquire token: {error}")

        self._save_cache()
        return result["access_token"]

    def _device_code_flow(self) -> dict:
        flow = self._app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow initiation failed: {flow}")

        print("\n" + "=" * 60)
        print("Microsoft 인증 필요")
        print("=" * 60)
        print(flow["message"])
        print("=" * 60 + "\n")

        return self._app.acquire_token_by_device_flow(flow)

    def get_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.get_token()}",
            "Content-Type": "application/json",
        }

    def get_base_url(self) -> str:
        return GRAPH_BASE
