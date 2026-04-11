"""Port of aggregateDaily() / backfillCityDaily() / prune sections from
workers/cron/src/index.ts.

Three public functions, each called by modal_cron.sync_daily:
- aggregate_daily()      — compute daily_stats for yesterday
- backfill_city_daily()  — fill city_daily gaps for yesterday and older dates
- prune_old_data()       — delete snapshots >30 days, active_trains/routes >7 days
"""
from __future__ import annotations

import cf_d1
import tz_utils

# ---------------------------------------------------------------------------
# Constants — mirrors MAJOR_CITIES in workers/cron/src/index.ts
# ---------------------------------------------------------------------------

MAJOR_CITIES: list[str] = [
    "Warszawa",
    "Kraków",
    "Gdańsk",
    "Wrocław",
    "Poznań",
]


# ---------------------------------------------------------------------------
# Pure helpers (extracted for unit testing)
# ---------------------------------------------------------------------------

def _compute_punctuality(on_time: int, total: int) -> float:
    """Round(onTime / total * 1000) / 10 — mirrors the TS formula."""
    if total <= 0:
        return 0.0
    return round(on_time / total * 1000) / 10


def _round1(value: float | int | None) -> float:
    """Round to 1 decimal place, returning 0.0 for None."""
    if value is None:
        return 0.0
    return round(float(value) * 10) / 10


# ---------------------------------------------------------------------------
# aggregate_daily
# ---------------------------------------------------------------------------

def aggregate_daily() -> None:
    """Compute daily_stats for yesterday from delay_snapshots.

    Port of aggregateDaily() step 1 — train-level stats only.
    City-level stats are in backfill_city_daily() (step 2 in TS lives in
    aggregateDaily but we expose it as a separate callable per the task spec).
    """
    yesterday = tz_utils.yesterday_date_str()
    print(f"[aggregate_daily] Aggregating data for {yesterday}")

    # ------------------------------------------------------------------
    # 1a. Station-level aggregates for the delay distribution buckets
    # ------------------------------------------------------------------
    stats_rows = cf_d1.query(
        "SELECT"
        "  COUNT(DISTINCT schedule_id || '-' || order_id) AS total_trains,"
        "  AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) <= 5"
        "           AND is_cancelled = 0 THEN 1 ELSE 0 END) AS on_time_stations,"
        "  SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END) AS cancelled_stations,"
        "  COUNT(*) AS total_stations,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 0 AND 5"
        "       THEN 1 ELSE 0 END) AS delay_0_5,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 6 AND 15"
        "       THEN 1 ELSE 0 END) AS delay_6_15,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 16 AND 30"
        "       THEN 1 ELSE 0 END) AS delay_16_30,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 31 AND 60"
        "       THEN 1 ELSE 0 END) AS delay_31_60,"
        "  SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) > 60"
        "       THEN 1 ELSE 0 END) AS delay_60_plus"
        " FROM delay_snapshots"
        " WHERE operating_date = ?",
        [yesterday],
    )

    if not stats_rows or not stats_rows[0] or not stats_rows[0].get("total_trains"):
        print(f"[aggregate_daily] No snapshots found for {yesterday}")
        return

    stats = stats_rows[0]

    # ------------------------------------------------------------------
    # 1b. Train-level on-time + cancelled counts (max delay per train)
    # ------------------------------------------------------------------
    train_rows = cf_d1.query(
        "SELECT"
        "  schedule_id || '-' || order_id AS train_key,"
        "  MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay,"
        "  MAX(is_cancelled) AS was_cancelled"
        " FROM delay_snapshots"
        " WHERE operating_date = ?"
        " GROUP BY schedule_id, order_id",
        [yesterday],
    )

    on_time_trains = 0
    cancelled_trains = 0
    total_trains = len(train_rows)

    for row in train_rows:
        if row.get("was_cancelled"):
            cancelled_trains += 1
        elif (row.get("max_delay") or 0) <= 5:
            on_time_trains += 1

    punctuality_pct = _compute_punctuality(on_time_trains, total_trains)
    avg_delay = _round1(stats.get("avg_delay"))

    # ------------------------------------------------------------------
    # 1c. Upsert daily_stats
    # ------------------------------------------------------------------
    cf_d1.query(
        "INSERT OR REPLACE INTO daily_stats"
        "  (date, total_trains, on_time_count, punctuality_pct, avg_delay, cancelled_count,"
        "   delay_0_5, delay_6_15, delay_16_30, delay_31_60, delay_60_plus)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            yesterday,
            total_trains,
            on_time_trains,
            punctuality_pct,
            avg_delay,
            cancelled_trains,
            stats.get("delay_0_5") or 0,
            stats.get("delay_6_15") or 0,
            stats.get("delay_16_30") or 0,
            stats.get("delay_31_60") or 0,
            stats.get("delay_60_plus") or 0,
        ],
    )

    print(
        f"[aggregate_daily] daily_stats — {total_trains} trains,"
        f" {on_time_trains} on time ({punctuality_pct}%), {cancelled_trains} cancelled"
    )


# ---------------------------------------------------------------------------
# backfill_city_daily
# ---------------------------------------------------------------------------

def backfill_city_daily() -> None:
    """Backfill city_daily for any dates in delay_snapshots that lack entries.

    Port of backfillCityDaily() from index.ts. Uses the first city in
    MAJOR_CITIES as the sentinel to detect which dates are missing, then
    computes all cities for each missing date.
    """
    print("[backfill_city_daily] Starting historical data backfill")

    # Find dates that exist in delay_snapshots but have no city_daily rows
    missing_rows = cf_d1.query(
        "SELECT DISTINCT ds.operating_date"
        " FROM delay_snapshots ds"
        " LEFT JOIN city_daily cd"
        "   ON cd.date = ds.operating_date AND cd.city = ?"
        " WHERE cd.date IS NULL"
        " ORDER BY ds.operating_date DESC"
        " LIMIT 30",
        [MAJOR_CITIES[0]],
    )

    if not missing_rows:
        print("[backfill_city_daily] No missing dates found")
        return

    print(f"[backfill_city_daily] Found {len(missing_rows)} missing dates")

    for date_row in missing_rows:
        date = date_row["operating_date"]
        print(f"[backfill_city_daily] Processing {date}")

        for city in MAJOR_CITIES:
            # Station-level aggregates for this city + date
            city_stats_rows = cf_d1.query(
                "SELECT"
                "  COUNT(DISTINCT schedule_id || '-' || order_id) AS train_count,"
                "  AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay"
                " FROM delay_snapshots ds"
                " LEFT JOIN stations s ON s.station_id = ds.station_id"
                " WHERE ds.operating_date = ?"
                "   AND (s.city = ? OR ds.station_name LIKE ?)",
                [date, city, f"{city}%"],
            )

            if not city_stats_rows or not city_stats_rows[0].get("train_count"):
                continue

            city_stats = city_stats_rows[0]

            # On-time trains for this city/date (max delay per train <= 5)
            on_time_rows = cf_d1.query(
                "SELECT COUNT(*) AS on_time FROM ("
                "  SELECT schedule_id, order_id,"
                "    MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay"
                "  FROM delay_snapshots ds"
                "  LEFT JOIN stations s ON s.station_id = ds.station_id"
                "  WHERE ds.operating_date = ?"
                "    AND (s.city = ? OR ds.station_name LIKE ?)"
                "  GROUP BY schedule_id, order_id"
                "  HAVING max_delay <= 5"
                ")",
                [date, city, f"{city}%"],
            )

            train_count = int(city_stats["train_count"] or 0)
            on_time = int((on_time_rows[0].get("on_time") if on_time_rows else None) or 0)
            avg_delay_val = _round1(city_stats.get("avg_delay"))
            punctuality = _compute_punctuality(on_time, train_count)

            cf_d1.query(
                "INSERT OR REPLACE INTO city_daily"
                " (city, date, train_count, avg_delay, punctuality_pct)"
                " VALUES (?, ?, ?, ?, ?)",
                [city, date, train_count, avg_delay_val, punctuality],
            )

            print(
                f"[backfill_city_daily] {city} {date}:"
                f" {train_count} trains, {punctuality}% punctual"
            )

    print("[backfill_city_daily] Backfill completed")


# ---------------------------------------------------------------------------
# prune_old_data
# ---------------------------------------------------------------------------

def prune_old_data() -> None:
    """Delete old rows to keep D1 storage bounded.

    - delay_snapshots: keep 30 days
    - active_trains:   keep 7 days
    - train_routes:    keep 7 days

    Port of the prune steps inside aggregateDaily() in index.ts.
    """
    # delay_snapshots — 30 days
    snap_result = cf_d1.query(
        "DELETE FROM delay_snapshots WHERE operating_date < date('now', '-30 days')"
    )
    snap_changes = snap_result[0].get("changes") if snap_result else 0
    print(f"[prune_old_data] Pruned {snap_changes} old snapshot rows")

    # active_trains — 7 days
    active_result = cf_d1.query(
        "DELETE FROM active_trains WHERE operating_date < date('now', '-7 days')"
    )
    active_changes = active_result[0].get("changes") if active_result else 0
    print(f"[prune_old_data] Pruned {active_changes} old active_trains rows")

    # train_routes — 7 days
    routes_result = cf_d1.query(
        "DELETE FROM train_routes WHERE operating_date < date('now', '-7 days')"
    )
    routes_changes = routes_result[0].get("changes") if routes_result else 0
    print(f"[prune_old_data] Pruned {routes_changes} old train_routes rows")
