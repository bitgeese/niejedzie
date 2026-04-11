"""Cloudflare D1 REST API client.

Wraps the D1 HTTP API so Modal functions can read/write the same database
the Astro worker uses natively. Supports single queries and batched
statement arrays in one POST.

Env vars (from modal Secret 'niejedzie-cloudflare'):
  CF_API_TOKEN      — API token with D1:Edit scope
  CF_ACCOUNT_ID     — Cloudflare account id
  D1_DATABASE_ID    — D1 database uuid
"""
from __future__ import annotations

import os
import time
from typing import Any

import requests

_BASE_TIMEOUT = 60.0
_MAX_ATTEMPTS = 3


def _endpoint() -> str:
    account = os.environ["CF_ACCOUNT_ID"]
    db_id = os.environ["D1_DATABASE_ID"]
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/d1/database/{db_id}/query"
    )


def _headers() -> dict[str, str]:
    token = os.environ["CF_API_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    """Execute a single SQL statement. Returns results as list of dicts."""
    body = {"sql": sql, "params": params or []}
    return _post_with_retry(body)[0]["results"]


def batch(statements: list[tuple[str, list[Any]]]) -> list[dict]:
    """Execute multiple SQL statements in one round-trip.

    Each statement is (sql, params). Returns list of
    `{meta, results, success}` dicts in the same order as the input.
    """
    body = [{"sql": sql, "params": params} for sql, params in statements]
    return _post_with_retry(body)


def _post_with_retry(body) -> list[dict]:
    url = _endpoint()
    headers = _headers()
    last_err: str | None = None

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=_BASE_TIMEOUT)
            if r.ok:
                payload = r.json()
                if not payload.get("success"):
                    raise RuntimeError(
                        f"D1 query reported failure: {payload.get('errors')}"
                    )
                return payload["result"]
            if r.status_code == 429 or 500 <= r.status_code < 600:
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(0.5 * attempt)
                    continue
            raise RuntimeError(
                f"D1 query failed HTTP {r.status_code}: {r.text[:500]}"
            )
        except requests.RequestException as e:
            last_err = str(e)
            if attempt < _MAX_ATTEMPTS:
                time.sleep(0.5 * attempt)
                continue
            raise RuntimeError(f"D1 network error: {last_err}") from e
    raise RuntimeError(f"D1 exhausted retries: {last_err}")
