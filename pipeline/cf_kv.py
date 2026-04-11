"""Cloudflare Workers KV REST API client.

Env vars (from 'niejedzie-cloudflare' secret):
  CF_API_TOKEN, CF_ACCOUNT_ID, KV_NAMESPACE_ID
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests


def _endpoint(key: str) -> str:
    account = os.environ["CF_ACCOUNT_ID"]
    ns = os.environ["KV_NAMESPACE_ID"]
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/storage/kv/namespaces/{ns}/values/{key}"
    )


def _headers(content_type: str = "application/json") -> dict[str, str]:
    token = os.environ["CF_API_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    }


def put(key: str, value: Any, expiration_ttl: int | None = None) -> None:
    """Write a JSON-serializable value to KV under `key`.

    Stores a JSON string since the Astro worker reads with `get(key, 'json')`.
    Matches `env.DELAYS_KV.put(key, JSON.stringify(obj), {expirationTtl})`.
    """
    url = _endpoint(key)
    if expiration_ttl is not None:
        url = f"{url}?expiration_ttl={expiration_ttl}"
    body = json.dumps(value) if not isinstance(value, (str, bytes)) else value
    r = requests.put(url, headers=_headers("text/plain"), data=body, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if not payload.get("success"):
        raise RuntimeError(f"KV put failed: {payload.get('errors')}")


def get(key: str) -> Any | None:
    """Read and JSON-decode a KV value. Returns None if the key doesn't exist."""
    url = _endpoint(key)
    r = requests.get(url, headers=_headers(), timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()
