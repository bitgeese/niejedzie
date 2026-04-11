"""Unit tests for pkp_api.py — extract_train_number and retry logic."""
from unittest.mock import patch, MagicMock
import pkp_api


def test_extract_train_number_prefers_national_number():
    route = {"nationalNumber": "49015", "name": None, "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "49015"


def test_extract_train_number_falls_through_to_international_departure():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": "5680",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "5680"


def test_extract_train_number_falls_through_to_international_arrival():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": None,
        "internationalArrivalNumber": "5387",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "5387"


def test_extract_train_number_falls_through_to_name():
    route = {
        "nationalNumber": None,
        "name": "KASZTELAN",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "KASZTELAN"


def test_extract_train_number_compound_placeholder():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": None,
        "internationalArrivalNumber": None,
        "name": None,
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "2026/12345"


def test_extract_train_number_strips_whitespace():
    route = {"nationalNumber": "  49015  ", "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "49015"


def test_extract_train_number_rejects_empty_string():
    route = {"nationalNumber": "", "name": "FOO", "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "FOO"


@patch("pkp_api.time.sleep")
@patch("pkp_api.requests.get")
def test_pkp_fetch_retries_on_5xx(mock_get, mock_sleep):
    mock_500 = MagicMock(status_code=530, ok=False, reason="Origin Error")
    mock_200 = MagicMock(status_code=200, ok=True)
    mock_200.json.return_value = {"routes": []}
    mock_get.side_effect = [mock_500, mock_200]

    result = pkp_api.pkp_fetch("/api/v1/schedules", "fake-key", {})
    assert result == {"routes": []}
    assert mock_get.call_count == 2
    # 5xx retry went through the linear backoff (500ms * 1)
    mock_sleep.assert_called_once_with(0.5)


@patch("pkp_api.time.sleep")
@patch("pkp_api.requests.get")
def test_pkp_fetch_gives_up_on_4xx(mock_get, mock_sleep):
    mock_401 = MagicMock(status_code=401, ok=False, reason="Unauthorized")
    mock_get.return_value = mock_401

    result = pkp_api.pkp_fetch("/api/v1/schedules", "fake-key", {})
    assert result is None
    assert mock_get.call_count == 1
    # No retry on 4xx, so no backoff sleep either
    mock_sleep.assert_not_called()
