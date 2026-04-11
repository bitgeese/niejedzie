"""Sanity tests for tz_utils — today and yesterday are consistent."""
from datetime import date
import tz_utils


def test_today_date_str_returns_iso_date():
    result = tz_utils.today_date_str()
    # Should parse as YYYY-MM-DD without raising
    date.fromisoformat(result)
    assert len(result) == 10
    assert result[4] == '-' and result[7] == '-'


def test_yesterday_is_one_day_before_today():
    today = date.fromisoformat(tz_utils.today_date_str())
    yesterday = date.fromisoformat(tz_utils.yesterday_date_str())
    assert (today - yesterday).days == 1
