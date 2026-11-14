"""Statistics used to prove the harmonization works (spec §5.4)."""
from __future__ import annotations

import numpy as np
import pymannkendall as mk


def pettitt(x: np.ndarray) -> dict:
    """Pettitt change-point test. Returns index of change, K statistic and approximate p-value."""
    x = np.asarray(x, float)
    n = len(x)
    s = np.sign(x[:, None] - x[None, :])
    u = np.array([s[: t + 1, t + 1 :].sum() for t in range(n - 1)])
    k = np.abs(u).max()
    t = int(np.abs(u).argmax())
    p = float(min(1.0, 2 * np.exp(-6 * k**2 / (n**3 + n**2))))
    return {"change_after_index": t, "K": float(k), "p": p}


def trend(x: np.ndarray, years: list[int]) -> dict:
    r = mk.original_test(np.asarray(x, float))
    return {"trend": r.trend, "p": float(r.p), "sen_slope_per_year": float(r.slope),
            "sen_slope_pct_of_mean": float(100 * r.slope / np.mean(x)) if np.mean(x) else None,
            "from": years[0], "to": years[-1]}


def step_ratio(annual: dict[int, float], before=(2009, 2011), after=(2012, 2014)) -> float:
    b = np.mean([annual[y] for y in range(before[0], before[1] + 1)])
    a = np.mean([annual[y] for y in range(after[0], after[1] + 1)])
    return float(a / b) if b else float("nan")
