"""Port of pollOperations() from workers/cron/src/index.ts.

Streams /api/v1/operations page-by-page, writes delay_snapshots + active_trains
to D1 per page, then computes and writes stats:today + operations:latest to KV.

KV payload shape is byte-compatible with the TS worker so the Astro frontend
/api/delays/today reads both paths identically.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import cf_d1
import cf_kv
import pkp_api
import tz_utils

_D1_CHUNK = 25


# ---------------------------------------------------------------------------
# Delay computation helpers (mirror computeDelay / computeDelayDeparture)
# ---------------------------------------------------------------------------

def _compute_delay(st: dict, operating_date: str) -> int:
    """Arrival delay in minutes. Returns 0 if data missing or >720 min diff."""
    if not st.get("plannedArrival") or not st.get("actualArrival"):
        return 0
    planned = datetime.fromisoformat(f"{operating_date}T{st['plannedArrival']}")
    actual = datetime.fromisoformat(st["actualArrival"])
    diff = round((actual.timestamp() - planned.timestamp()) / 60)
    if abs(diff) > 720:
        return 0
    return diff


def _compute_delay_departure(st: dict, operating_date: str) -> int:
    """Departure delay in minutes. Returns 0 if data missing or >720 min diff."""
    if not st.get("plannedDeparture") or not st.get("actualDeparture"):
        return 0
    planned = datetime.fromisoformat(f"{operating_date}T{st['plannedDeparture']}")
    actual = datetime.fromisoformat(st["actualDeparture"])
    diff = round((actual.timestamp() - planned.timestamp()) / 60)
    if abs(diff) > 720:
        return 0
    return diff


# ---------------------------------------------------------------------------
# Top-delayed helper (extracted for unit testing)
# ---------------------------------------------------------------------------

def _trim_top_delayed(
    candidates: list[dict], limit: int = 20
) -> list[dict]:
    """Sort candidates by delay descending and slice to limit."""
    return sorted(candidates, key=lambda c: c["delay"], reverse=True)[:limit]


# ---------------------------------------------------------------------------
# D1 batching
# ---------------------------------------------------------------------------

def _batch_in_chunks(statements: list[tuple]) -> None:
    for i in range(0, len(statements), _D1_CHUNK):
        cf_d1.bulk_insert(statements[i : i + _D1_CHUNK])


# ---------------------------------------------------------------------------
# Main function
# ---------------------------------------------------------------------------

_SNAPSHOT_SQL = (
    "INSERT OR REPLACE INTO delay_snapshots"
    " (schedule_id, order_id, operating_date, station_id, station_name,"
    "  sequence_num, planned_arrival, planned_departure, actual_arrival,"
    "  actual_departure, arrival_delay, departure_delay, is_confirmed, is_cancelled)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

_ACTIVE_TRAIN_SQL = (
    "INSERT OR REPLACE INTO active_trains"
    " (operating_date, train_number, train_number_numeric, carrier, agency_id,"
    "  trip_id, stop_count, is_delayed, max_delay, schedule_id, order_id, updated_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
)


def poll_operations() -> None:
    """Port of pollOperations(env).

    1. Load train metadata from D1.
    2. Fetch PKP official statistics.
    3. Stream operations pages — write snapshots + active_trains per page.
    4. Compute aggregated stats.
    5. Write stats:today and operations:latest to KV.
    """
    api_key = os.environ["PKP_API_KEY"]
    today = tz_utils.today_date_str()
    print(f"[poll_operations] Starting poll for {today}")

    # -------------------------------------------------------------------------
    # 1. Load train metadata
    # -------------------------------------------------------------------------
    train_meta_rows = cf_d1.query(
        "SELECT schedule_id, order_id, train_number, carrier, category,"
        " route_start, route_end FROM trains"
    )
    train_meta: dict[str, dict] = {}
    for row in train_meta_rows:
        key = f"{row['schedule_id']}-{row['order_id']}"
        train_meta[key] = {
            "train_number": row["train_number"],
            "carrier": row.get("carrier"),
            "category": row.get("category"),
            "route_start": row.get("route_start"),
            "route_end": row.get("route_end"),
        }

    # -------------------------------------------------------------------------
    # 2. Fetch official stats (sequential — Python is synchronous)
    # -------------------------------------------------------------------------
    pkp_stats = pkp_api.fetch_statistics(api_key, today)
    if pkp_stats is None:
        print("[poll_operations] PKP stats unavailable — will use accumulated counters")

    # -------------------------------------------------------------------------
    # 3. Accumulators
    # -------------------------------------------------------------------------
    total_delay = 0
    delay_count = 0
    on_time_count = 0
    cancelled_count = 0
    total_trains_seen = 0
    seen_train_ids: set[str] = set()

    # topDelayed candidates — trimmed to top 20 across pages, final top 10 at end
    top_delayed_candidates: list[dict[str, Any]] = []

    # -------------------------------------------------------------------------
    # 4. Page handler (called per page by fetch_operations_pages)
    # -------------------------------------------------------------------------
    def on_page(trains: list[dict], stations: dict[str, str], page_num: int) -> None:
        nonlocal total_delay, delay_count, on_time_count, cancelled_count
        nonlocal total_trains_seen

        snapshot_batch: list[tuple] = []
        active_train_batch: list[tuple] = []

        for train in trains:
            train_key = f"{train['scheduleId']}-{train['orderId']}"
            is_new = train_key not in seen_train_ids
            if is_new:
                seen_train_ids.add(train_key)
                total_trains_seen += 1

            # Skip Scheduled (S) trains — no delay data yet
            if train.get("trainStatus") == "S":
                if is_new:
                    on_time_count += 1
                continue

            meta = train_meta.get(train_key)
            train_number = (
                meta["train_number"] if meta else
                f"{train['scheduleId']}/{train['orderId']}"
            )
            carrier = (meta["carrier"] or "") if meta else ""

            train_max_delay = 0
            train_cancelled = False
            operating_date = train.get("operatingDate") or today

            # Build delay_snapshots rows for this train
            for st in train.get("stations") or []:
                station_name = stations.get(str(st["stationId"]), "")
                if not station_name or not station_name.strip():
                    continue
                if not any([
                    st.get("plannedArrival"),
                    st.get("plannedDeparture"),
                    st.get("actualArrival"),
                    st.get("actualDeparture"),
                ]):
                    continue

                arr_delay = (
                    st["arrivalDelayMinutes"]
                    if st.get("arrivalDelayMinutes") is not None
                    else _compute_delay(st, operating_date)
                )
                dep_delay = (
                    st["departureDelayMinutes"]
                    if st.get("departureDelayMinutes") is not None
                    else _compute_delay_departure(st, operating_date)
                )
                # The TS computes `delay` as `st.arrivalDelayMinutes ?? arrDelay`
                # (i.e. prefer the API's arrival delay for accumulation)
                delay = (
                    st["arrivalDelayMinutes"]
                    if st.get("arrivalDelayMinutes") is not None
                    else arr_delay
                )

                if abs(delay) > abs(train_max_delay):
                    train_max_delay = delay
                if st.get("isCancelled"):
                    train_cancelled = True

                if is_new and (st.get("actualArrival") or st.get("actualDeparture")):
                    total_delay += delay
                    delay_count += 1

                snapshot_batch.append((
                    _SNAPSHOT_SQL,
                    [
                        train["scheduleId"],
                        train["orderId"],
                        operating_date,
                        st["stationId"],
                        station_name,
                        st.get("actualSequenceNumber") if st.get("actualSequenceNumber") is not None
                            else (st.get("plannedSequenceNumber") or 0),
                        st.get("plannedArrival") or None,
                        st.get("plannedDeparture") or None,
                        st.get("actualArrival") or None,
                        st.get("actualDeparture") or None,
                        arr_delay,
                        dep_delay,
                        1 if st.get("isConfirmed") else 0,
                        1 if st.get("isCancelled") else 0,
                    ],
                ))

            # Per-train accumulators (only once per unique train)
            if is_new:
                if train_cancelled or train.get("trainStatus") == "Cancelled":
                    cancelled_count += 1
                elif train_max_delay <= 5:
                    on_time_count += 1

            # Build active_trains row
            max_delay = 0
            is_delayed = False
            for st in train.get("stations") or []:
                d = (
                    st["arrivalDelayMinutes"]
                    if st.get("arrivalDelayMinutes") is not None
                    else _compute_delay(st, operating_date)
                )
                if d > max_delay:
                    max_delay = d
                if d > 5:
                    is_delayed = True

            # Placeholder compound IDs have no meaningful numeric train number
            is_placeholder = "/" in train_number
            numeric_match = (
                None if is_placeholder else re.search(r"\d+", train_number)
            )
            train_number_numeric = numeric_match.group(0) if numeric_match else ""

            active_train_batch.append((
                _ACTIVE_TRAIN_SQL,
                [
                    operating_date,
                    train_number,
                    train_number_numeric,
                    carrier,
                    "",  # agency_id not available from PKP API
                    f"{train['scheduleId']}-{train['orderId']}",  # trip_id
                    len(train.get("stations") or []),
                    1 if is_delayed else 0,
                    max_delay,
                    train["scheduleId"],
                    train["orderId"],
                ],
            ))

            # Collect topDelayed candidates
            if max_delay > 0:
                station_list = train.get("stations") or []
                first_station = station_list[0] if station_list else None
                last_station = station_list[-1] if station_list else None
                route_start = (
                    meta["route_start"] if meta and meta.get("route_start")
                    else stations.get(str(first_station["stationId"]), "?")
                    if first_station else "?"
                )
                route_end = (
                    meta["route_end"] if meta and meta.get("route_end")
                    else stations.get(str(last_station["stationId"]), "?")
                    if last_station else "?"
                )
                last_station_name = (
                    stations.get(str(last_station["stationId"]), "")
                    if last_station else ""
                )
                top_delayed_candidates.append({
                    "trainNumber": train_number,
                    "delay": max_delay,
                    "route": f"{route_start} \u2192 {route_end}",
                    "station": last_station_name,
                    "carrier": carrier,
                })
                # Trim to keep memory bounded — keep only top 20 candidates
                if len(top_delayed_candidates) > 20:
                    top_delayed_candidates[:] = _trim_top_delayed(
                        top_delayed_candidates, limit=20
                    )

        # Write snapshots and active_trains immediately for this page
        if snapshot_batch:
            try:
                _batch_in_chunks(snapshot_batch)
            except Exception as e:
                print(f"[poll_operations] Snapshot write failed on page {page_num}: {e}")
        if active_train_batch:
            try:
                _batch_in_chunks(active_train_batch)
            except Exception as e:
                print(
                    f"[poll_operations] Active trains upsert failed on page {page_num}: {e}"
                )
        print(
            f"[poll_operations] Page {page_num} — wrote {len(snapshot_batch)} snapshots,"
            f" {len(active_train_batch)} active_trains"
        )

    # -------------------------------------------------------------------------
    # 5. Stream all pages
    # -------------------------------------------------------------------------
    result = pkp_api.fetch_operations_pages(api_key, on_page)
    api_total_trains: int = result["total_trains"]

    if total_trains_seen == 0:
        print("[poll_operations] No trains from API — skipping stats write")
        return

    print(f"[poll_operations] All pages processed — {total_trains_seen} unique trains")

    # -------------------------------------------------------------------------
    # 6. Final stats computation
    # -------------------------------------------------------------------------
    avg_delay = round(total_delay / delay_count, 1) if delay_count else 0
    punctuality_pct = (
        round(on_time_count / total_trains_seen * 1000) / 10
        if total_trains_seen else 0
    )
    top_delayed = _trim_top_delayed(top_delayed_candidates, limit=10)

    # -------------------------------------------------------------------------
    # 7. Fetch active disruptions from KV
    # -------------------------------------------------------------------------
    disruptions: list[dict] = []
    try:
        disruptions_raw = cf_kv.get("disruptions:active")
        if disruptions_raw and disruptions_raw.get("disruptions"):
            disruptions = [
                {
                    "message": d.get("message", ""),
                    "route": f"{d.get('startStation', '')} \u2192 {d.get('endStation', '')}",
                }
                for d in disruptions_raw["disruptions"]
            ]
    except Exception as e:
        print(f"[poll_operations] Failed to fetch disruptions from KV: {e}")

    # -------------------------------------------------------------------------
    # 8. Compute hourly delay breakdown from D1
    # -------------------------------------------------------------------------
    hourly_delays: list[dict] = []
    try:
        hourly_rows = cf_d1.query(
            "SELECT"
            "  strftime('%H:00', COALESCE(planned_departure, planned_arrival)) AS hour,"
            "  ROUND(AVG(COALESCE(departure_delay, arrival_delay, 0)), 1) AS avg_delay"
            " FROM delay_snapshots"
            " WHERE operating_date = ?"
            "   AND COALESCE(planned_departure, planned_arrival) IS NOT NULL"
            " GROUP BY hour ORDER BY hour",
            [today],
        )
        hourly_delays = [
            {"hour": r["hour"], "avgDelay": r["avg_delay"]}
            for r in hourly_rows
        ]
    except Exception as e:
        print(f"[poll_operations] Failed to compute hourly delays: {e}")

    # -------------------------------------------------------------------------
    # 9. Compute accumulated daily punctuality from all delay_snapshots today
    # -------------------------------------------------------------------------
    daily_punctuality: float | None = None
    daily_avg_delay: float | None = None
    try:
        daily_rows = cf_d1.query(
            "SELECT"
            "  COUNT(*) AS total_trains,"
            "  SUM(CASE WHEN max_delay <= 5 THEN 1 ELSE 0 END) AS on_time,"
            "  ROUND(AVG(CASE WHEN max_delay > 0 THEN max_delay ELSE 0 END), 1) AS avg_delay"
            " FROM ("
            "   SELECT schedule_id, order_id,"
            "     MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay"
            "   FROM delay_snapshots"
            "   WHERE operating_date = ?"
            "   GROUP BY schedule_id, order_id"
            " )",
            [today],
        )
        if daily_rows:
            row = daily_rows[0]
            total = int(row.get("total_trains") or 0)
            on_time = int(row.get("on_time") or 0)
            if total > 0:
                daily_punctuality = round(on_time / total * 1000) / 10
                daily_avg_delay = float(row.get("avg_delay") or 0)
    except Exception as e:
        print(f"[poll_operations] Failed to compute daily punctuality: {e}")

    # -------------------------------------------------------------------------
    # 10. Build and write stats:today to KV
    # -------------------------------------------------------------------------
    iso_now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    today_stats: dict[str, Any] = {
        "timestamp": iso_now,
        "totalTrains": pkp_stats["totalTrains"] if pkp_stats else api_total_trains,
        "avgDelay": daily_avg_delay if daily_avg_delay is not None else avg_delay,
        "punctualityPct": daily_punctuality if daily_punctuality is not None else punctuality_pct,
        "cancelledCount": pkp_stats["cancelled"] if pkp_stats else cancelled_count,
        "onTimeCount": on_time_count,
        "pkpOfficialStats": {
            "totalTrains": pkp_stats["totalTrains"],
            "completed": pkp_stats["completed"],
            "inProgress": pkp_stats["inProgress"],
            "notStarted": pkp_stats["notStarted"],
            "cancelled": pkp_stats["cancelled"],
            "partialCancelled": pkp_stats["partialCancelled"],
        } if pkp_stats else None,
        "dailyPunctuality": daily_punctuality,
        "dailyAvgDelay": daily_avg_delay,
        "topDelayed": top_delayed,
        "disruptions": disruptions,
        "hourlyDelays": hourly_delays,
    }

    try:
        cf_kv.put("stats:today", today_stats, expiration_ttl=600)
        print("[poll_operations] KV stats:today written successfully")
    except Exception as e:
        print(f"[poll_operations] FAILED to write KV stats: {e}")

    print(
        f"[poll_operations] Stats — trains: {today_stats['totalTrains']},"
        f" onTime: {on_time_count}, avgDelay: {avg_delay}min,"
        f" cancelled: {cancelled_count},"
        f" punctuality: {today_stats['punctualityPct']}%"
    )

    # -------------------------------------------------------------------------
    # 11. Write operations:latest to KV
    # -------------------------------------------------------------------------
    try:
        cf_kv.put(
            "operations:latest",
            {"timestamp": iso_now, "trainCount": total_trains_seen},
            expiration_ttl=600,
        )
    except Exception as e:
        print(f"[poll_operations] Failed to write operations:latest: {e}")
