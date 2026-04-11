"""Unit tests for aggregate_daily.py — pure helper logic."""
import aggregate_daily


# ---------------------------------------------------------------------------
# _compute_punctuality
# ---------------------------------------------------------------------------

def test_compute_punctuality_zero_total():
    assert aggregate_daily._compute_punctuality(0, 0) == 0.0
    assert aggregate_daily._compute_punctuality(5, 0) == 0.0


def test_compute_punctuality_all_on_time():
    result = aggregate_daily._compute_punctuality(100, 100)
    assert result == 100.0


def test_compute_punctuality_none_on_time():
    result = aggregate_daily._compute_punctuality(0, 100)
    assert result == 0.0


def test_compute_punctuality_rounds_to_one_decimal():
    # 2 / 3 = 0.6666… → round(666.6) / 10 = 66.7
    result = aggregate_daily._compute_punctuality(2, 3)
    assert result == 66.7


def test_compute_punctuality_typical_value():
    # 850 / 1000 = 85.0%
    result = aggregate_daily._compute_punctuality(850, 1000)
    assert result == 85.0


def test_compute_punctuality_mirrors_ts_formula():
    # TS: Math.round(onTime / total * 1000) / 10
    # 7 / 13 = 0.538461… → round(538.46) = 538 → 53.8
    result = aggregate_daily._compute_punctuality(7, 13)
    assert result == 53.8


# ---------------------------------------------------------------------------
# _round1
# ---------------------------------------------------------------------------

def test_round1_none_returns_zero():
    assert aggregate_daily._round1(None) == 0.0


def test_round1_integer():
    assert aggregate_daily._round1(5) == 5.0


def test_round1_rounds_correctly():
    # 12.35 → 12.4 (Python rounds half-to-even, but *10 then round then /10 is stable)
    result = aggregate_daily._round1(12.34)
    assert result == 12.3


def test_round1_negative():
    result = aggregate_daily._round1(-3.75)
    assert result == -3.8


def test_round1_zero():
    assert aggregate_daily._round1(0) == 0.0


# ---------------------------------------------------------------------------
# MAJOR_CITIES constant
# ---------------------------------------------------------------------------

def test_major_cities_non_empty():
    assert len(aggregate_daily.MAJOR_CITIES) > 0


def test_major_cities_contains_warszawa():
    assert "Warszawa" in aggregate_daily.MAJOR_CITIES


def test_major_cities_no_duplicates():
    assert len(aggregate_daily.MAJOR_CITIES) == len(set(aggregate_daily.MAJOR_CITIES))
