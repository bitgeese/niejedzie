"""Unit tests for poll_disruptions.py — pure helper logic."""
import poll_disruptions


# ---------------------------------------------------------------------------
# _build_upsert_params
# ---------------------------------------------------------------------------

def test_build_upsert_params_all_fields():
    d = {
        "disruptionId": 42,
        "disruptionTypeCode": "DELAY",
        "startStation": "Warszawa Centralna",
        "endStation": "Kraków Główny",
        "message": "Train is late",
    }
    params = poll_disruptions._build_upsert_params(d)
    assert params == [42, "DELAY", "Warszawa Centralna", "Kraków Główny", "Train is late"]


def test_build_upsert_params_missing_optional_fields():
    d = {"disruptionId": 7}
    params = poll_disruptions._build_upsert_params(d)
    assert params[0] == 7
    assert params[1] is None
    assert params[2] is None
    assert params[3] is None
    assert params[4] is None


def test_build_upsert_params_preserves_order():
    d = {
        "disruptionId": 1,
        "disruptionTypeCode": "TC",
        "startStation": "A",
        "endStation": "B",
        "message": "msg",
    }
    params = poll_disruptions._build_upsert_params(d)
    # Must match the INSERT column order: disruption_id, type_code, start_station, end_station, message
    assert len(params) == 5
    assert params[0] == 1
    assert params[1] == "TC"
    assert params[2] == "A"
    assert params[3] == "B"
    assert params[4] == "msg"


# ---------------------------------------------------------------------------
# _stale_ids
# ---------------------------------------------------------------------------

def test_stale_ids_returns_missing():
    current = [1, 2, 3]
    all_ids = [1, 2, 3, 4, 5]
    stale = poll_disruptions._stale_ids(current, all_ids)
    assert set(stale) == {4, 5}


def test_stale_ids_empty_current():
    current = []
    all_ids = [10, 20, 30]
    stale = poll_disruptions._stale_ids(current, all_ids)
    assert set(stale) == {10, 20, 30}


def test_stale_ids_all_current():
    current = [1, 2, 3]
    all_ids = [1, 2, 3]
    stale = poll_disruptions._stale_ids(current, all_ids)
    assert stale == []


def test_stale_ids_empty_all():
    current = [1, 2]
    all_ids = []
    stale = poll_disruptions._stale_ids(current, all_ids)
    assert stale == []


def test_stale_ids_does_not_mutate_inputs():
    current = [1, 2]
    all_ids = [1, 2, 3]
    poll_disruptions._stale_ids(current, all_ids)
    assert current == [1, 2]
    assert all_ids == [1, 2, 3]
