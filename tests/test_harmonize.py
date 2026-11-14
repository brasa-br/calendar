import numpy as np
import pandas as pd

from pipeline import harmonize as H
from pipeline.validate import pettitt, step_ratio


def _series(k=3.0, n=168, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.period_range("2012-01", periods=n, freq="M").strftime("%Y-%m")
    m = pd.Series(rng.gamma(2.0, 500.0, n).round(), index=idx)
    v = pd.Series((k * m * np.exp(rng.normal(0, 0.1, n))).round(), index=idx)
    return m, v


def test_c2_recovers_ratio():
    m, v = _series(k=3.0)
    f = H.fit_model("C2", m, v)
    assert abs(f.params["k"] - 3.0) / 3.0 < 0.05


def test_c3_recovers_loglinear_slope_and_covers():
    m, v = _series(k=3.0)
    f = H.fit_model("C3", m, v)
    assert abs(f.params["b"] - 1.0) < 0.05
    p, lo, hi = H.predict(f, m)
    assert (p >= 0).all() and (lo <= p).all() and (p <= hi).all()
    assert ((v.values >= lo) & (v.values <= hi)).mean() >= 0.85


def test_c4_uses_season_term():
    m, v = _series()
    f = H.fit_model("C4", m, v)
    assert "season" in f.params and len(f.peaks) == 4


def test_metrics_perfect():
    x = np.array([10, 100, 1000])
    r = H.metrics(x, x)
    assert r["rmse_log"] == 0 and r["bias"] == 0


def test_terra_only_adjustment():
    idx = H.month_index()
    w = pd.DataFrame(index=idx)
    w["terra"] = 100.0
    w["aqua"] = np.where(idx >= "2002-07", 200.0, 0.0)
    w["modis_raw"] = w.terra + w.aqua
    k, t = H.terra_aqua_ratio(w)
    assert np.allclose(k.values, 3.0)
    m = H.homogenize_modis(w, k)
    assert m["2001-05"] == 300 and m["2010-05"] == 300


def test_pettitt_detects_step():
    x = np.r_[np.ones(11) * 100, np.ones(14) * 320] + np.arange(25) % 3
    assert pettitt(x)["change_after_index"] == 10
    a = {y: (100 if y < 2012 else 320) for y in range(2001, 2026)}
    assert abs(step_ratio(a) - 3.2) < 1e-9
