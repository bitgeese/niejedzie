"""Unit tests for poll_disruptions.py — pure helper logic."""
import poll_disruptions


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
    # Must match INSERT column order: disruption_id, type_code, start_station, end_station, message
    assert len(params) == 5
    assert params == [1, "TC", "A", "B", "msg"]
