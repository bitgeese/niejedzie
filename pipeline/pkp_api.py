"""PKP PLK Open Data API client — Python port of workers/cron/src/pkp-api.ts.

Preserves:
- 3-attempt retry with linear backoff for 5xx / network errors (no retry on 4xx)
- extract_train_number precedence: nationalNumber → internationalDepartureNumber →
  internationalArrivalNumber → name → compound {scheduleId}/{orderId}
"""
from __future__ import annotations

import time
from typing import Callable

import requests

PKP_API_BASE = "https://pdp-api.plk-sa.pl"
MAX_ATTEMPTS = 3


def pkp_fetch(
    path: str,
    api_key: str,
    params: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict | None:
    """Fetch a PKP API path with retry. Returns parsed JSON or None on failure."""
    url = PKP_API_BASE + path
    headers = {"X-API-Key": api_key, "Accept": "application/json"}

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = requests.get(url, headers=headers, params=params or {}, timeout=timeout)
            if r.ok:
                return r.json()
            if r.status_code < 500 or attempt == MAX_ATTEMPTS:
                print(
                    f"[pkp_fetch] {r.status_code} {r.reason} for {path} "
                    f"(attempt {attempt}/{MAX_ATTEMPTS})"
                )
                return None
            print(f"[pkp_fetch] {r.status_code} on {path}, retrying")
        except requests.RequestException as e:
            if attempt == MAX_ATTEMPTS:
                print(f"[pkp_fetch] network error on {path}: {e}")
                return None
            print(f"[pkp_fetch] network error on {path}, retrying: {e}")
        time.sleep(0.5 * attempt)
    return None


def extract_train_number(route: dict) -> str:
    """Return the real train number for a /schedules route.

    Precedence matches workers/cron/src/index.ts:extractTrainNumber exactly:
    nationalNumber → internationalDepartureNumber → internationalArrivalNumber →
    name → compound {scheduleId}/{orderId} (last-resort placeholder).
    """
    for key in (
        "nationalNumber",
        "internationalDepartureNumber",
        "internationalArrivalNumber",
        "name",
    ):
        value = route.get(key)
        if value is not None and isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return f"{route['scheduleId']}/{route['orderId']}"


def fetch_operations_pages(
    api_key: str,
    on_page: Callable[[list[dict], dict[str, str], int], None],
) -> dict:
    """Stream paged /api/v1/operations, calling on_page(trains, stations, page_num) per page.

    Returns {'total_trains': N, 'stations': {id: name}}.
    """
    all_stations: dict[str, str] = {}
    total_trains = 0
    page = 1
    page_size = 2000
    max_pages = 100

    while page <= max_pages:
        res = pkp_fetch(
            "/api/v1/operations",
            api_key,
            {
                "fullRoutes": "true",
                "withPlanned": "true",
                "page": str(page),
                "pageSize": str(page_size),
            },
        )
        if not res or not res.get("trains"):
            if page == 1:
                print("[fetch_operations_pages] no data on first page")
            break

        all_stations.update(res.get("stations", {}))
        trains = res["trains"]
        total_trains += len(trains)
        on_page(trains, all_stations, page)

        if not res.get("pagination", {}).get("hasNextPage"):
            break
        page += 1

    print(f"[fetch_operations_pages] processed {total_trains} trains across {page} pages")
    return {"total_trains": total_trains, "stations": all_stations}


def fetch_statistics(api_key: str, date: str) -> dict | None:
    """GET /api/v1/operations/statistics?date=YYYY-MM-DD"""
    return pkp_fetch("/api/v1/operations/statistics", api_key, {"date": date})


def fetch_schedules_pages(
    api_key: str,
    date: str,
    on_page: Callable[[list[dict], dict[str, str], int], None],
) -> dict:
    """Stream paged /api/v1/schedules for a single date. Accumulates dictionaries across pages."""
    all_stations: dict[str, str] = {}
    all_carriers: dict[str, str] = {}
    total_routes = 0
    page = 1
    page_size = 1000
    max_pages = 100

    while page <= max_pages:
        res = pkp_fetch(
            "/api/v1/schedules",
            api_key,
            {
                "dateFrom": date,
                "dateTo": date,
                "dictionaries": "true",
                "page": str(page),
                "pageSize": str(page_size),
            },
        )
        if not res or not res.get("routes"):
            if page == 1:
                print("[fetch_schedules_pages] no data on first page")
            break

        dictionaries = res.get("dictionaries") or {}
        stations_dict = dictionaries.get("stations") or {}
        for sid, info in stations_dict.items():
            all_stations[str(sid)] = info["name"] if isinstance(info, dict) else info
        all_carriers.update(dictionaries.get("carriers") or {})

        routes = res["routes"]
        total_routes += len(routes)
        on_page(routes, all_stations, page)

        if len(routes) < page_size:
            break
        page += 1

    return {"total_routes": total_routes, "stations": all_stations, "carriers": all_carriers}


def fetch_disruptions(api_key: str) -> list[dict]:
    """GET /api/v1/disruptions. Returns list or empty on failure."""
    res = pkp_fetch("/api/v1/disruptions", api_key)
    if not res or not res.get("success") or not res.get("data", {}).get("disruptions"):
        return []
    return res["data"]["disruptions"]
