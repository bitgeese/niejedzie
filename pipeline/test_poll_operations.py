"""Unit tests for poll_operations.py — critical business logic."""
import poll_operations


def test_trim_top_delayed_sorts_and_slices():
    candidates = [
        {"trainNumber": "A", "delay": 10},
        {"trainNumber": "B", "delay": 50},
        {"trainNumber": "C", "delay": 5},
        {"trainNumber": "D", "delay": 100},
    ]
    result = poll_operations._trim_top_delayed(candidates, limit=3)
    assert [c["trainNumber"] for c in result] == ["D", "B", "A"]
    assert len(result) == 3


def test_trim_top_delayed_returns_all_when_under_limit():
    candidates = [
        {"trainNumber": "X", "delay": 20},
        {"trainNumber": "Y", "delay": 1},
    ]
    result = poll_operations._trim_top_delayed(candidates, limit=10)
    assert len(result) == 2
    assert result[0]["trainNumber"] == "X"


def test_trim_top_delayed_empty_input():
    result = poll_operations._trim_top_delayed([], limit=10)
    assert result == []


def test_trim_top_delayed_does_not_mutate_input():
    candidates = [
        {"trainNumber": "A", "delay": 10},
        {"trainNumber": "B", "delay": 50},
        {"trainNumber": "C", "delay": 5},
    ]
    original_order = [c["trainNumber"] for c in candidates]
    poll_operations._trim_top_delayed(candidates, limit=2)
    assert [c["trainNumber"] for c in candidates] == original_order


def test_compute_delay_returns_zero_on_missing_data():
    st = {"plannedArrival": None, "actualArrival": None}
    assert poll_operations._compute_delay(st, "2026-04-11") == 0


def test_compute_delay_computes_positive_delay():
    # 10 minutes late
    st = {
        "plannedArrival": "10:00:00",
        "actualArrival": "2026-04-11T10:10:00",
    }
    assert poll_operations._compute_delay(st, "2026-04-11") == 10


def test_compute_delay_clamps_beyond_720_minutes():
    # Date mismatch — actual is the next day, producing a multi-hour diff
    st = {
        "plannedArrival": "23:00:00",
        "actualArrival": "2026-04-12T00:01:00",  # 61 min later — ok
    }
    result = poll_operations._compute_delay(st, "2026-04-11")
    assert abs(result) <= 720


def test_compute_delay_clamps_day_jump_as_zero():
    # actual is 2 days later → diff >> 720 → clamped to 0
    st = {
        "plannedArrival": "10:00:00",
        "actualArrival": "2026-04-13T10:00:00",
    }
    assert poll_operations._compute_delay(st, "2026-04-11") == 0


def test_compute_delay_departure_returns_zero_on_missing_data():
    st = {"plannedDeparture": None, "actualDeparture": None}
    assert poll_operations._compute_delay_departure(st, "2026-04-11") == 0


def test_compute_delay_departure_computes_positive_delay():
    st = {
        "plannedDeparture": "08:30:00",
        "actualDeparture": "2026-04-11T08:45:00",
    }
    assert poll_operations._compute_delay_departure(st, "2026-04-11") == 15
