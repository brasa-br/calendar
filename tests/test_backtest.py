import numpy as np

from pipeline import backtest as B


def _series(years: dict[int, list[float]], provisional: set[int] = frozenset()):
    months, harm, src = [], [], []
    for y, vals in sorted(years.items()):
        for m, v in enumerate(vals, 1):
            months.append(f"{y}-{m:02d}")
            harm.append(v)
            src.append("viirs_provisional" if y in provisional else "viirs_observed")
    return {"months": months, "harmonized": harm, "source": src}


def test_ahead_since():
    assert B.ahead_since([False, True, True]) == 2
    assert B.ahead_since([True, False, True]) == 3
    assert B.ahead_since([True, True, False]) is None


def test_backtest_flags_severe_year_before_peak():
    normal = [1] * 6 + [10, 20, 10] + [1] * 3
    years = {y: normal for y in range(2001, 2010)}
    years[2010] = [3] * 6 + [30, 60, 30] + [1] * 3  # ahead from January, ~3x a normal year
    b = B.backtest({"X": _series(years)}, {"X": "Region X"})
    assert b["severe"] == 1
    assert b["events"][0]["year"] == 2010 and b["events"][0]["first_ahead"] == 1
    jul = next(r for r in b["by_month"] if r["month"] == 7)
    assert jul["hits"] == 1 and jul["missed"] == 0
    assert b["ahead_before_peak"] == 1 and b["median_lead_months"] == 7.0


def test_current_uses_only_complete_earlier_years():
    normal = [1] * 12
    years = {y: normal for y in range(2001, 2008)}
    years[2008] = [5, 5, 5] + [np.nan] * 9
    s = _series({y: v for y, v in years.items()}, provisional={2008})
    s["months"] = [m for m, v in zip(s["months"], s["harmonized"]) if v == v]
    s["source"] = [x for x, v in zip(s["source"], s["harmonized"]) if v == v]
    s["harmonized"] = [v for v in s["harmonized"] if v == v]
    c = B.current({"X": s}, {"X": "Region X"})
    r = c["regions"][0]
    assert c["year"] == 2008 and c["through_month"] == 3
    assert r["ahead"] and r["since"] == 1 and r["vs_median"] == 5.0 and r["rank"] == 1
