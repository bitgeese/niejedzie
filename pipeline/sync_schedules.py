"""Port of syncSchedulesForDate() from workers/cron/src/index.ts.

Fetches /api/v1/schedules for a given date and upserts into:
  - trains          (schedule_id, order_id, train_number, carrier, category,
                     route_start, route_end, updated_at)
  - train_routes    (operating_date, train_number, stop_sequence, stop_id,
                     arrival_time, departure_time, trip_id)
  - stations        (station_id, name, city)

D1 writes are batched via cf_d1.batch() in chunks of 25 (the Python helper's
safe ceiling — the D1 REST API allows up to 100 but 25 keeps payloads small).
"""
from __future__ import annotations

import os

import cf_d1
import pkp_api

_D1_CHUNK = 25


def _batch_in_chunks(statements: list[tuple]) -> None:
    """Execute D1 batch statements in chunks of _D1_CHUNK."""
    for i in range(0, len(statements), _D1_CHUNK):
        cf_d1.bulk_insert(statements[i : i + _D1_CHUNK])


def sync_schedules_for_date(date: str) -> int:
    """Port of syncSchedulesForDate(env, date).

    Pulls /api/v1/schedules for *date*, upserts trains + train_routes, then
    refreshes the stations dictionary.  Returns total route count.
    """
    api_key = os.environ["PKP_API_KEY"]

    train_sql = (
        "INSERT OR REPLACE INTO trains"
        " (schedule_id, order_id, train_number, carrier, category,"
        "  route_start, route_end, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    )
    route_sql = (
        "INSERT OR REPLACE INTO train_routes"
        " (operating_date, train_number, stop_sequence, stop_id,"
        "  arrival_time, departure_time, trip_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)"
    )

    def on_page(routes: list[dict], stations: dict[str, str], page_num: int) -> None:
        train_batch: list[tuple] = []
        route_batch: list[tuple] = []

        for route in routes:
            train_number = pkp_api.extract_train_number(route)
            carrier = route.get("carrierCode") or ""
            category = route.get("commercialCategorySymbol") or ""

            station_list = route.get("stations") or []
            first_st = station_list[0] if station_list else None
            last_st = station_list[-1] if station_list else None
            route_start = stations.get(str(first_st["stationId"]), "") if first_st else ""
            route_end = stations.get(str(last_st["stationId"]), "") if last_st else ""

            train_batch.append((
                train_sql,
                [
                    route["scheduleId"],
                    route["orderId"],
                    train_number,
                    carrier,
                    category,
                    route_start,
                    route_end,
                ],
            ))

            trip_id = f"{route['scheduleId']}-{route['orderId']}"
            for st in station_list:
                route_batch.append((
                    route_sql,
                    [
                        date,
                        train_number,
                        st["orderNumber"],
                        st["stationId"],
                        st.get("arrivalTime") or None,
                        st.get("departureTime") or None,
                        trip_id,
                    ],
                ))

        if train_batch:
            _batch_in_chunks(train_batch)
        if route_batch:
            _batch_in_chunks(route_batch)
        print(
            f"[sync_schedules] {date} page {page_num} — "
            f"{len(train_batch)} trains, {len(route_batch)} stops"
        )

    result = pkp_api.fetch_schedules_pages(api_key, date, on_page)
    total_routes: int = result["total_routes"]
    station_dict: dict[str, str] = result["stations"]

    # Update stations from accumulated dictionary
    station_sql = "INSERT OR REPLACE INTO stations (station_id, name, city) VALUES (?, ?, ?)"
    station_batch: list[tuple] = []
    for id_str, name in station_dict.items():
        try:
            station_id = int(id_str)
        except (ValueError, TypeError):
            continue
        city = name.split()[0] if name.split() else name
        station_batch.append((station_sql, [station_id, name, city]))

    if station_batch:
        _batch_in_chunks(station_batch)

    print(
        f"[sync_schedules] Done — {total_routes} routes, "
        f"{len(station_batch)} stations upserted"
    )
    return total_routes
