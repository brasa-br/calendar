"""Orchestrates harmonization, validation and writes web/public/data/*.json (spec §5–6)."""
from __future__ import annotations

import datetime as dt
import json
import math

import numpy as np
import pandas as pd

from . import config as C
from . import harmonize as H
from .regions import load_boundaries, regions_table
from .validate import pettitt, step_ratio, trend

QA_MIN_FRAC = 0.8


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if math.isnan(o) or math.isinf(o) else round(float(o), 6)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def dump(path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_clean(obj), ensure_ascii=False, separators=(",", ":")))


def qa_masks(cov: pd.DataFrame, idx: pd.Index) -> tuple[pd.Series, pd.Series]:
    cov = cov.copy()
    cov["frac"] = cov.days / pd.PeriodIndex(cov.ym, freq="M").days_in_month
    f = cov.pivot_table(index="ym", columns="platform", values="frac").reindex(idx).fillna(0)
    terra_bad = f.get("Terra", 0) < QA_MIN_FRAC
    aqua_bad = (f.get("Aqua", 0) < QA_MIN_FRAC) & (idx >= C.AQUA_FULL_FROM)
    modis_bad = pd.Series(terra_bad | aqua_bad, index=idx)
    viirs_bad = pd.Series((f.get("S-NPP", 0) < QA_MIN_FRAC) & (idx >= C.OVERLAP_START), index=idx)
    return modis_bad, viirs_bad


def main() -> None:
    monthly = pd.read_parquet(C.INTERIM / "monthly.parquet")
    cov = pd.read_parquet(C.INTERIM / "coverage.parquet")
    build_meta = json.loads((C.INTERIM / "build_meta.json").read_text())
    versions = pd.read_parquet(C.INTERIM / "versions.parquet")
    bounds = load_boundaries()
    regs = regions_table(bounds)
    parent = {r["id"]: r["parent"] for r in regs}
    idx = H.month_index()
    modis_bad, viirs_bad = qa_masks(cov, idx)
    overlap = H.in_window(idx, C.OVERLAP_START, C.OVERLAP_END)
    calib = pd.Series(overlap, index=idx) & ~modis_bad & ~viirs_bad

    # ---- per-region inputs (parents processed first: BR, biomes, states, RMC) ----
    W, M, KTA, ELIG = {}, {}, {}, {}
    for r in regs:
        rid = r["id"]
        w = H.wide_series(monthly, rid)
        k, tsum = H.terra_aqua_ratio(w)
        if parent[rid] is not None:
            pk = KTA[parent[rid]]
            k = k.where(tsum >= C.MIN_TERRA_FOR_OWN_KTA, pk)
        k = k.reindex([f"{i:02d}" for i in range(1, 13)]).fillna(KTA.get("BR", pd.Series(dtype=float)).get("01", 1.0))
        KTA[rid] = k
        W[rid] = w
        M[rid] = H.homogenize_modis(w, k)
        v = w.viirs[calib]
        ELIG[rid] = bool(v.sum() >= C.MIN_VIIRS_FOR_OWN_MODEL and (M[rid][calib] > 0).sum() >= C.MIN_NONZERO_MODIS_MONTHS)

    def fit_for(rid, model, mask, k_global, cache):
        """Fit with parent fallback (parent's C2 ratio) for ineligible regions."""
        key = (rid, model)
        if key in cache:
            return cache[key]
        if model in ("C2", "C3", "C4") and not ELIG[rid]:
            f = fit_for(parent[rid], "C2", mask, k_global, cache)
            cache[key] = f
            return f
        f = H.fit_model(model, M[rid][mask], W[rid].viirs[mask], k_global=k_global)
        cache[key] = f
        return f

    # ---- cross-validation ----
    cv_rows, scatter = [], []
    for (tr, te) in C.CV_FOLDS:
        trm = calib & H.in_window(idx, *tr)
        tem = calib & H.in_window(idx, *te)
        k_global = float(W["BR"].viirs[trm].sum() / M["BR"][trm].sum())
        cache = {}
        for r in regs:
            rid = r["id"]
            for model in H.MODELS:
                f = fit_for(rid, model, trm, k_global, cache)
                pred, _, _ = H.predict(f, M[rid][tem])
                obs = W[rid].viirs[tem].values
                cv_rows.append({"region": rid, "fold": f"{tr[0][:4]}-{tr[1][:4]}", "model": model,
                                **H.metrics(obs, pred)})
                if r["kind"] == "biome" and model in ("C2", "C3", "C4"):
                    for ym, o, p in zip(idx[tem], obs, pred):
                        scatter.append({"region": rid, "model": model, "ym": ym, "obs": int(o), "pred": float(p)})
    cv = pd.DataFrame(cv_rows)
    summary = cv.groupby("model")[["rmse_log", "r2_log", "mape_ge50", "bias"]].mean()
    summary_abs_bias = cv.assign(ab=cv.bias.abs()).groupby("model")["ab"].mean()
    best = summary.loc[["C1", "C2", "C3", "C4"], "rmse_log"].idxmin()
    print(summary.round(3).to_string())
    print("selected:", best)

    # ---- final fits on full calibration window ----
    k_global = float(W["BR"].viirs[calib].sum() / M["BR"][calib].sum())
    cache = {}
    series_meta, all_rows, region_params = {}, [], {}
    ann = {}
    for r in regs:
        rid = r["id"]
        f = fit_for(rid, best, calib, k_global, cache)
        own = ELIG[rid] or best in ("C0", "C1")
        pred, lo, hi = H.predict(f, M[rid])
        v = W[rid].viirs
        harm = np.where(idx < C.OVERLAP_START, pred, v.fillna(0).values)
        hlo = np.where(idx < C.OVERLAP_START, lo, harm)
        hhi = np.where(idx < C.OVERLAP_START, hi, harm)
        src = np.where(idx < C.AQUA_FULL_FROM, "modis_terra_adjusted",
                       np.where(idx < C.OVERLAP_START, "harmonized_modis", "viirs_observed")).astype(object)
        gap = (viirs_bad & ~modis_bad).values
        harm = np.where(gap, pred, harm)
        hlo = np.where(gap, lo, hlo)
        hhi = np.where(gap, hi, hhi)
        src[gap] = "modis_gapfill"
        qa = np.where(idx < C.OVERLAP_START, modis_bad.values, viirs_bad.values & modis_bad.values).astype(int)
        naive = np.where(idx < C.OVERLAP_START, W[rid].modis_raw.values, v.fillna(0).values)
        out = {
            "region": rid, "model": f.model if own else f"C2 (parent: {parent[rid]})",
            "model_source": "own" if own else "parent", "months": list(idx),
            "harmonized": np.rint(harm).astype(int).tolist(),
            "lo": np.rint(hlo).astype(int).tolist(), "hi": np.rint(hhi).astype(int).tolist(),
            "source": src.tolist(),
            "modis_raw": W[rid].modis_raw.astype(int).tolist(),
            "viirs_raw": [None if pd.isna(x) else int(x) for x in v.values],
            "naive": np.rint(naive).astype(int).tolist(),
            "qa_flag": qa.tolist(),
        }
        dump(C.WEB_DATA / "series" / f"{rid}.json", out)
        region_params[rid] = {"model": out["model"], "params": f.params,
                              "k_terra_aqua": KTA[rid].round(4).to_dict(), "eligible_own_model": ELIG[rid]}
        for i, ym in enumerate(idx):
            all_rows.append((rid, ym, out["harmonized"][i], out["lo"][i], out["hi"][i], out["source"][i],
                             out["modis_raw"][i], out["viirs_raw"][i], out["naive"][i], out["qa_flag"][i]))
        if rid == "BR":
            df = pd.DataFrame({"y": idx.str[:4].astype(int), "h": out["harmonized"], "lo": out["lo"],
                               "hi": out["hi"], "m": out["modis_raw"], "n": out["naive"]})
            ann = df[(df.y >= 2001) & (df.y <= 2025)].groupby("y").sum()

    pd.DataFrame(all_rows, columns=["region", "month", "harmonized", "lo", "hi", "source", "modis_raw",
                                    "viirs_raw", "naive", "qa_flag"]).to_csv(
        C.WEB_DATA / "all_regions_monthly.csv", index=False)

    # ---- proof statistics (Brazil, annual 2001-2025) ----
    years = ann.index.tolist()
    proof = {"annual": {"years": years, "harmonized": ann.h.tolist(), "lo": ann.lo.tolist(), "hi": ann.hi.tolist(),
                        "modis_raw": ann.m.tolist(), "naive": ann.n.tolist()}}
    for name, col in (("naive", "n"), ("harmonized", "h"), ("modis_raw", "m")):
        a = ann[col].to_dict()
        pt = pettitt(ann[col].values)
        pt["change_year"] = years[pt["change_after_index"] + 1]
        proof[name] = {"step_2012": step_ratio(a), "pettitt": pt, "trend": trend(ann[col].values, years)}

    # ---- sensitivity (Brazil C2 ratio on calibration window) ----
    def br_ratio(col):
        w = H.wide_series(monthly, "BR", col)
        return float(w.viirs[calib].sum() / w.modis_raw[calib].sum())
    sens = {"default_nominal_high": br_ratio("n"), "including_low_confidence": br_ratio("n_all"),
            "daytime_only": br_ratio("n_day"), "fire_cell_days_0.1deg": br_ratio("fire_days")}

    cov2 = cov.copy()
    cov2["frac"] = cov2.days / pd.PeriodIndex(cov2.ym, freq="M").days_in_month
    degraded = cov2[cov2.frac < QA_MIN_FRAC].sort_values(["platform", "ym"])
    meta = {
        "generated_utc": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"),
        "span": [C.START_MONTH, C.END_MONTH],
        "sources": {
            "MODIS": {"product": "MODIS Collection 6.1 active fires (Terra + Aqua), FIRMS",
                      "url": f"{C.FIRMS_BASE}/modis/YYYY/modis_YYYY_Brazil.csv",
                      "years": [min(C.MODIS_YEARS), max(C.MODIS_YEARS)]},
            "VIIRS": {"product": "VIIRS S-NPP 375 m active fires (VNP14IMG), FIRMS",
                      "url": f"{C.FIRMS_BASE}/viirs-snpp/YYYY/viirs-snpp_YYYY_Brazil.csv",
                      "years": [min(C.VIIRS_YEARS), max(C.VIIRS_YEARS)]},
            "boundaries": "IBGE via geobr (states 2020, biomes 2019, metro areas 2018)",
            "accessed": "2026-11-14",
        },
        "build": build_meta,
        "versions": versions.groupby(["sensor", "version"]).agg(first=("year", "min"), last=("year", "max"),
                                                                 n=("n", "sum")).reset_index().to_dict("records"),
        "qa": {"min_coverage_fraction": QA_MIN_FRAC,
               "degraded_months": degraded[["sensor", "platform", "ym", "days"]].to_dict("records")},
        "calibration_months": int(calib.sum()),
        "selected_model": best,
        "cv_summary": {m: {**summary.loc[m].to_dict(), "mean_abs_bias": summary_abs_bias[m]} for m in H.MODELS},
        "cv_by_region": cv[cv.model == best].groupby("region")[["rmse_log", "r2_log", "bias"]].mean()
                          .reset_index().to_dict("records"),
        "k_global_viirs_per_modis": k_global,
        "regions": region_params,
        "proof": proof,
        "sensitivity_br_ratio": sens,
    }
    dump(C.WEB_DATA / "meta.json", meta)
    sc = pd.DataFrame(scatter)
    sc = sc[sc.model == best]
    if len(sc) > 2000:
        sc = sc.sample(2000, random_state=1)
    dump(C.WEB_DATA / "validation.json", {"model": best, "points": sc.to_dict("records")})
    dump(C.WEB_DATA / "regions.json", regs)
    export_grid()
    export_boundaries(bounds)
    print(json.dumps(_clean({k: proof[k] for k in ("naive", "harmonized", "modis_raw")}), indent=1))
    print("sensitivity", sens)


def export_grid() -> None:
    g = pd.read_parquet(C.INTERIM / "grid025.parquet")
    br = json.loads((C.WEB_DATA / "meta.json").read_text())["k_global_viirs_per_modis"]
    for y in sorted(g.year.unique()):
        d = g[g.year == y]
        if y >= 2012:
            d = d[d.sensor == "VIIRS"]
            vals = d[["iy", "ix", "n"]].values.tolist()
        else:
            d = d[d.sensor == "MODIS"]
            vals = [[a, b, int(round(n * br))] for a, b, n in d[["iy", "ix", "n"]].values]
        dump(C.WEB_DATA / "grid" / f"{y}.json", {"cell": C.MAP_CELL, "year": int(y),
                                                 "estimated": bool(y < 2012), "cells": vals})


def export_boundaries(b) -> None:
    import topojson as tp
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.geometry.polygon import orient

    def clockwise(geom):
        # d3-geo is spherical: exterior rings must be clockwise or the shape fills the globe.
        if isinstance(geom, Polygon):
            return orient(geom, sign=-1.0)
        if isinstance(geom, MultiPolygon):
            return MultiPolygon([orient(p, sign=-1.0) for p in geom.geoms])
        return geom

    layers = {}
    for k, tol in (("states", 0.02), ("biomes", 0.02), ("rmc", 0.003)):
        g = b[k].copy()
        g["geometry"] = g.geometry.simplify(tol, preserve_topology=True).apply(clockwise)
        keep = {"states": ["uf", "name"], "biomes": ["biome", "name"], "rmc": ["name_muni"]}[k]
        layers[k] = g[keep + ["geometry"]]
    topo = tp.Topology(list(layers.values()), object_name=list(layers.keys()), prequantize=1e5, toposimplify=False)
    (C.WEB_DATA / "boundaries.topo.json").write_text(topo.to_json())


if __name__ == "__main__":
    main()
