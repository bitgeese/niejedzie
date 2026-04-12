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


def _query_endpoint() -> str:
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
    return _post_with_retry(_query_endpoint(), body)[0]["results"]


def batch(statements: list[tuple[str, list[Any]]]) -> list[dict]:
    """Execute multiple SQL statements sequentially via the /query endpoint.

    The CF D1 REST API does not have a native batch endpoint — batch() is only
    available via the Workers D1 binding. This falls back to individual POSTs.
    Each statement is (sql, params). Returns list of result dicts.
    """
    results = []
    for sql, params in statements:
        body = {"sql": sql, "params": params or []}
        result = _post_with_retry(_query_endpoint(), body)
        results.append(result[0])
    return results


_D1_MAX_VARIABLES = 99  # CF D1 REST API limit per statement


def bulk_insert(statements: list[tuple[str, list[Any]]]) -> list[dict]:
    """Execute a batch of identical INSERT statements as multi-row INSERTs.

    All statements must share the same SQL template. Rewrites them into one or
    more multi-row INSERT ... VALUES (?,...), (?,...) calls, capped at
    _D1_MAX_VARIABLES bound parameters per HTTP call.

    This is necessary because the CF D1 REST /query endpoint only accepts one
    statement at a time and has no batch endpoint via HTTP. Multi-row VALUES
    reduces N HTTP calls to ceil(N / rows_per_call).

    Each statement is (sql, params). Returns list of result meta dicts.
    """
    if not statements:
        return []

    sqls = [s[0] for s in statements]
    if len(set(sqls)) != 1:
        raise ValueError("bulk_insert requires all statements to use the same SQL template")

    sql_template = sqls[0]
    upper = sql_template.upper()
    values_idx = upper.rfind("VALUES")
    if values_idx == -1:
        raise ValueError("bulk_insert SQL must contain VALUES clause")

    prefix = sql_template[: values_idx + len("VALUES")]
    row_placeholder = sql_template[values_idx + len("VALUES"):].strip()

    # Determine params per row from the first statement
    params_per_row = len(statements[0][1]) if statements[0][1] else 1
    # Cap rows per call to stay under the D1 variable limit
    rows_per_call = max(1, _D1_MAX_VARIABLES // params_per_row)

    results = []
    for i in range(0, len(statements), rows_per_call):
        chunk = statements[i : i + rows_per_call]
        placeholders = ", ".join(row_placeholder for _ in chunk)
        flat_params = [p for _, params in chunk for p in (params or [])]
        merged_sql = f"{prefix} {placeholders}"
        body = {"sql": merged_sql, "params": flat_params}
        result = _post_with_retry(_query_endpoint(), body)
        results.append(result[0])
    return results


def _post_with_retry(url: str, body) -> Any:
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
