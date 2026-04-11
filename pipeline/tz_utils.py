"""Poland-timezone date helpers. Mirrors workers/cron/src/index.ts todayDateStr().

Cron fires on UTC schedule but we compute dates in Europe/Warsaw so per-day
aggregates line up with the rest of the Polish rail system.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

WARSAW = ZoneInfo("Europe/Warsaw")


def today_date_str() -> str:
    """Return today's date in Warsaw timezone as YYYY-MM-DD."""
    return datetime.now(timezone.utc).astimezone(WARSAW).date().isoformat()


def yesterday_date_str() -> str:
    """Return yesterday's date in Warsaw timezone as YYYY-MM-DD."""
    warsaw_now = datetime.now(timezone.utc).astimezone(WARSAW)
    return (warsaw_now - timedelta(days=1)).date().isoformat()
