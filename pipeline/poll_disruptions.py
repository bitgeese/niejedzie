"""Port of pollDisruptions() from workers/cron/src/index.ts.

Fetches /api/v1/disruptions, upserts D1 disruptions table, writes
disruptions:active KV with a 10-minute TTL.

KV payload shape:
    {"timestamp": "<ISO>", "disruptions": [...]}
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import cf_d1
import cf_kv
import pkp_api

_D1_CHUNK = 25


def _batch_upserts(statements: list[tuple]) -> None:
    for i in range(0, len(statements), _D1_CHUNK):
        cf_d1.batch(statements[i : i + _D1_CHUNK])


# ---------------------------------------------------------------------------
# Pure helpers (extracted for unit testing)
# ---------------------------------------------------------------------------

def _build_upsert_params(d: dict) -> list:
    """Return the D1 param list for a single disruption upsert."""
    return [
        d["disruptionId"],
        d.get("disruptionTypeCode"),
        d.get("startStation"),
        d.get("endStation"),
        d.get("message"),
    ]


# ---------------------------------------------------------------------------
# Main function
# ---------------------------------------------------------------------------

_UPSERT_SQL = (
    "INSERT INTO disruptions"
    " (disruption_id, type_code, start_station, end_station, message, last_seen, is_active)"
    " VALUES (?, ?, ?, ?, ?, datetime('now'), 1)"
    " ON CONFLICT(disruption_id) DO UPDATE SET"
    "   type_code = excluded.type_code,"
    "   start_station = excluded.start_station,"
    "   end_station = excluded.end_station,"
    "   message = excluded.message,"
    "   last_seen = datetime('now'),"
    "   is_active = 1"
)


def poll_disruptions() -> None:
    """Port of pollDisruptions(env).

    1. Fetch disruptions from PKP API.
    2. Write disruptions:active to KV (hot cache for frontend).
    3. Upsert each disruption into D1.
    4. Mark disruptions absent from this response as inactive.
    """
    api_key = os.environ["PKP_API_KEY"]
    print("[poll_disruptions] Starting")

    disruptions = pkp_api.fetch_disruptions(api_key)

    if not disruptions:
        print("[poll_disruptions] No disruptions from API")
    else:
        print(f"[poll_disruptions] Fetched {len(disruptions)} disruptions")

    # -------------------------------------------------------------------------
    # 1. Write to KV (hot cache for frontend)
    # -------------------------------------------------------------------------
    iso_now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        cf_kv.put(
            "disruptions:active",
            {"timestamp": iso_now, "disruptions": disruptions},
            expiration_ttl=600,
        )
    except Exception as e:
        print(f"[poll_disruptions] FAILED to write KV disruptions:active: {e}")

    # -------------------------------------------------------------------------
    # 2. Upsert each disruption into D1
    # -------------------------------------------------------------------------
    if disruptions:
        stmts = [(_UPSERT_SQL, _build_upsert_params(d)) for d in disruptions]
        try:
            _batch_upserts(stmts)
        except Exception as e:
            print(f"[poll_disruptions] D1 upsert failed: {e}")

    # -------------------------------------------------------------------------
    # 3. Mark disruptions NOT in current response as inactive
    # -------------------------------------------------------------------------
    if disruptions:
        active_ids = [d["disruptionId"] for d in disruptions]
        placeholders = ", ".join("?" for _ in active_ids)
        try:
            cf_d1.query(
                f"UPDATE disruptions SET is_active = 0"
                f" WHERE is_active = 1 AND disruption_id NOT IN ({placeholders})",
                active_ids,
            )
        except Exception as e:
            print(f"[poll_disruptions] Failed to mark stale disruptions inactive: {e}")
    else:
        # No active disruptions — mark all as inactive
        try:
            cf_d1.query("UPDATE disruptions SET is_active = 0 WHERE is_active = 1")
        except Exception as e:
            print(f"[poll_disruptions] Failed to mark all disruptions inactive: {e}")

    print("[poll_disruptions] Done")
