"""MODIS -> VIIRS-equivalent harmonization (spec §5). Pure functions over pandas objects."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import statsmodels.api as sm

from . import config as C

MODELS = ("C0", "C1", "C2", "C3", "C4")


def month_index(start: str = C.START_MONTH, end: str = C.END_MONTH) -> pd.Index:
    return pd.period_range(start, end, freq="M").strftime("%Y-%m")


def wide_series(monthly: pd.DataFrame, region: str, col: str = "n") -> pd.DataFrame:
    """-> DataFrame indexed by ym with terra, aqua, modis_raw, viirs (NaN before VIIRS era)."""
    idx = month_index()
    d = monthly[monthly.region_id == region]
    piv = d.pivot_table(index="ym", columns="platform", values=col, aggfunc="sum").reindex(idx)
    out = pd.DataFrame(index=idx)
    out["terra"] = piv.get("Terra", pd.Series(dtype=float)).reindex(idx).fillna(0)
    out["aqua"] = piv.get("Aqua", pd.Series(dtype=float)).reindex(idx).fillna(0)
    out["modis_raw"] = out.terra + out.aqua
    v = piv.get("S-NPP", pd.Series(dtype=float)).reindex(idx).fillna(0)
    v[idx < C.OVERLAP_START] = np.nan
    out["viirs"] = v
    return out


# ---------- Step A: Terra-only period ----------

def terra_aqua_ratio(w: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Per month-of-year k_TA = sum(T+A)/sum(T) over the fit window; also Terra sums (support)."""
    a, b = C.TERRA_AQUA_FIT
    fit = w[(w.index >= a) & (w.index <= b)]
    moy = fit.index.str[5:7]
    t = fit.terra.groupby(moy).sum()
    ta = fit.modis_raw.groupby(moy).sum()
    k = (ta / t.replace(0, np.nan))
    return k, t


def homogenize_modis(w: pd.DataFrame, k_ta: pd.Series) -> pd.Series:
    """Terra-only/partial-Aqua months scaled by k_TA(month-of-year); later months = Terra + Aqua."""
    m = w.modis_raw.copy()
    early = w.index < C.AQUA_FULL_FROM
    moy = w.index[early].str[5:7]
    m[early] = w.terra[early].values * k_ta.reindex(moy).fillna(1.0).values
    return m


# ---------- Step B: calibration models ----------

def peak_months(m: pd.Series, n: int = 4) -> list[str]:
    clim = m.groupby(m.index.str[5:7]).mean()
    return sorted(clim.nlargest(n).index.tolist())


@dataclass
class Fit:
    model: str
    params: dict = field(default_factory=dict)
    resid: np.ndarray | None = None
    ols: object | None = None
    peaks: list[str] = field(default_factory=list)


def _design(m: pd.Series, model: str, peaks: list[str]) -> np.ndarray:
    x = np.log1p(m.values.astype(float))
    cols = [np.ones_like(x), x]
    if model == "C4":
        cols.append(m.index.str[5:7].isin(peaks).astype(float))
    return np.column_stack(cols)


def fit_model(model: str, m: pd.Series, v: pd.Series, k_global: float | None = None,
              peaks: list[str] | None = None) -> Fit:
    ok = v.notna() & m.notna()
    m, v = m[ok], v[ok]
    if model == "C0":
        return Fit("C0")
    if model == "C1":
        return Fit("C1", {"k": float(k_global)})
    if model == "C2":
        k = float(v.sum() / max(m.sum(), 1))
        sel = m >= 20
        lr = np.log(v[sel].clip(lower=1) / (k * m[sel])) if sel.any() else np.array([0.0])
        return Fit("C2", {"k": k, "q_lo": float(np.quantile(lr, (1 - C.PI_LEVEL) / 2)),
                          "q_hi": float(np.quantile(lr, 1 - (1 - C.PI_LEVEL) / 2))})
    pk = peaks if peaks is not None else peak_months(m)
    X = _design(m, model, pk)
    y = np.log1p(v.values.astype(float))
    res = sm.OLS(y, X).fit()
    smear = float(np.mean(np.exp(res.resid)))
    p = {"a": float(res.params[0]), "b": float(res.params[1]), "smear": smear, "r2_log": float(res.rsquared)}
    if model == "C4":
        p["season"] = float(res.params[2])
    return Fit(model, p, res.resid, res, pk)


def predict(fit: Fit, m: pd.Series) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (point, lo, hi) in counts, non-negative."""
    mv = m.values.astype(float)
    if fit.model == "C0":
        return mv, mv, mv
    if fit.model == "C1":
        p = fit.params["k"] * mv
        return p, p, p
    if fit.model == "C2":
        p = fit.params["k"] * mv
        return p, p * np.exp(fit.params["q_lo"]), p * np.exp(fit.params["q_hi"])
    X = _design(m, fit.model, fit.peaks)
    pr = fit.ols.get_prediction(X).summary_frame(alpha=1 - C.PI_LEVEL)
    point = fit.params["smear"] * np.exp(pr["mean"].values) - 1
    lo = np.expm1(pr["obs_ci_lower"].values)
    hi = np.expm1(pr["obs_ci_upper"].values)
    clip = lambda a: np.clip(a, 0, None)  # noqa: E731
    return clip(point), clip(lo), clip(hi)


def metrics(obs: np.ndarray, pred: np.ndarray) -> dict:
    obs = np.asarray(obs, float)
    pred = np.asarray(pred, float)
    lo, lp = np.log1p(obs), np.log1p(pred)
    rmse = float(np.sqrt(np.mean((lo - lp) ** 2)))
    ss = np.sum((lo - lo.mean()) ** 2)
    r2 = float(1 - np.sum((lo - lp) ** 2) / ss) if ss > 0 else float("nan")
    big = obs >= 50
    mape = float(np.mean(np.abs(pred[big] - obs[big]) / obs[big])) if big.any() else float("nan")
    bias = float((pred.sum() - obs.sum()) / obs.sum()) if obs.sum() > 0 else float("nan")
    return {"rmse_log": rmse, "r2_log": r2, "mape_ge50": mape, "bias": bias, "n": int(len(obs))}


def in_window(idx: pd.Index, a: str, b: str) -> np.ndarray:
    return (idx >= a) & (idx <= b)
