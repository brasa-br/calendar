"""Early-warning check: does "ahead of every earlier year" flag severe fire years in time?

For every region and every year from FIRST_TEST to the last complete year, the year's running
total of harmonized hotspots is compared, month by month, with the running totals of all earlier
years (only data that was available at the time). A year is *flagged* by month m when its total
through m is above every earlier year's total through m. A year is *severe* when its full-year
total is at least SEVERE_X times the median full-year total of the earlier years.

It also writes the same signal for the current year, region by region, for the site's
"Running ahead this year" list. Output: web/public/data/warning.json.
"""

import json

import numpy as np

from pipeline import config as C

FIRST_YEAR = 2001
FIRST_TEST = 2006  # every tested year has at least five earlier years to compare with
SEVERE_X = 2.0
CHECK_MONTHS = list(range(4, 10))  # flagged by the end of April ... September


def yearly_matrix(series: dict) -> tuple[dict[int, np.ndarray], set[int]]:
    """Monthly harmonized values by year, and the set of years with 12 non-provisional months."""
    by_year: dict[int, np.ndarray] = {}
    prov: set[int] = set()
    for ym, v, src in zip(series["months"], series["harmonized"], series["source"]):
        y, m = int(ym[:4]), int(ym[5:7])
        if y < FIRST_YEAR:
            continue
        row = by_year.setdefault(y, np.full(12, np.nan))
        row[m - 1] = 0.0 if v is None else float(v)
        if src == "viirs_provisional":
            prov.add(y)
    complete = {y for y, r in by_year.items() if not np.isnan(r).any() and y not in prov}
    return by_year, complete


def ahead_months(cum: np.ndarray, earlier: np.ndarray, upto: int) -> list[bool]:
    """For months 1..upto, is the running total above every earlier year's running total?"""
    return [bool(cum[m] > earlier[:, m].max()) for m in range(upto)]


def ahead_since(flags: list[bool]) -> int | None:
    """First month (1-based) from which the year stayed ahead through the last month checked."""
    if not flags or not flags[-1]:
        return None
    m = len(flags)
    while m > 1 and flags[m - 2]:
        m -= 1
    return m


def backtest(all_series: dict[str, dict], names: dict[str, str]) -> dict:
    flags: dict[int, list[bool]] = {m: [] for m in CHECK_MONTHS}
    severe_list: list[bool] = []
    ratios: list[float] = []
    events = []
    years_tested: set[int] = set()
    for rid, s in all_series.items():
        by_year, complete = yearly_matrix(s)
        years = sorted(y for y in complete if y >= FIRST_YEAR)
        for y in years:
            if y < FIRST_TEST:
                continue
            prior = [p for p in years if p < y]
            if len(prior) < 5:
                continue
            years_tested.add(y)
            cum = np.cumsum(by_year[y])
            earlier = np.array([np.cumsum(by_year[p]) for p in prior])
            median_total = float(np.median(earlier[:, 11]))
            ratio = cum[11] / median_total if median_total > 0 else 0.0
            severe = median_total > 0 and ratio >= SEVERE_X
            severe_list.append(bool(severe))
            ratios.append(float(ratio))
            full = ahead_months(cum, earlier, 12)
            for m in CHECK_MONTHS:
                flags[m].append(full[m - 1])
            if severe:
                first = next((m + 1 for m, f in enumerate(full) if f), None)
                events.append({
                    "region": rid, "name": names.get(rid, rid), "year": y,
                    "ratio": round(ratio, 2), "first_ahead": first,
                    "peak_month": int(np.argmax(by_year[y])) + 1,
                })
    sev = np.array(severe_list)
    rat = np.array(ratios)
    by_month = []
    for m in CHECK_MONTHS:
        f = np.array(flags[m])
        hits = int((f & sev).sum())
        flagged = int(f.sum())
        unflagged = int((~f).sum())
        by_month.append({
            "month": m, "flagged": flagged, "hits": hits, "missed": int((~f & sev).sum()),
            "false_alarms": flagged - hits,
            "p_severe_if_flagged": round(hits / flagged, 3) if flagged else None,
            "p_severe_if_not": round(int((~f & sev).sum()) / unflagged, 4) if unflagged else None,
            # Years flagged but under the severe line: how far above a normal year did they still end?
            "false_alarm_median_ratio": round(float(np.median(rat[f & ~sev])), 2) if flagged > hits else None,
        })
    events.sort(key=lambda e: (-e["ratio"]))
    early = [e for e in events if e["first_ahead"] and e["first_ahead"] < e["peak_month"]]
    return {
        "severe_x": SEVERE_X,
        "years": [min(years_tested), max(years_tested)] if years_tested else None,
        "regions": len(all_series),
        "region_years": len(severe_list),
        "severe": int(sev.sum()),
        "by_month": by_month,
        "ahead_before_peak": len(early),
        "median_lead_months": float(np.median([e["peak_month"] - e["first_ahead"] for e in early])) if early else None,
        "events": events,
    }


def current(all_series: dict[str, dict], names: dict[str, str]) -> dict | None:
    """Where the latest year stands, region by region, through its latest month."""
    out = []
    year = last = None
    for rid, s in all_series.items():
        by_year, complete = yearly_matrix(s)
        y = max(by_year)
        row = by_year[y]
        n = int((~np.isnan(row)).sum())
        prior = sorted(p for p in complete if p < y)
        if n == 0 or len(prior) < 5:
            continue
        year, last = y, n
        cum = np.cumsum(row[:n])
        earlier = np.array([np.cumsum(by_year[p])[:n] for p in prior])
        med = float(np.median(earlier[:, n - 1]))
        flags = ahead_months(cum, earlier, n)
        out.append({
            "region": rid, "name": names.get(rid, rid), "total": int(round(cum[-1])),
            "vs_median": round(cum[-1] / med, 2) if med > 0 else None,
            "ahead": flags[-1], "since": ahead_since(flags),
            "rank": int(1 + (earlier[:, n - 1] > cum[-1]).sum()), "of": len(prior) + 1,
        })
    if not out:
        return None
    out.sort(key=lambda r: -(r["vs_median"] or 0))
    return {"year": year, "through_month": last, "regions": out}


def main() -> None:
    names = {r["id"]: r["name"] for r in json.loads((C.WEB_DATA / "regions.json").read_text())}
    all_series = {p.stem: json.loads(p.read_text()) for p in sorted((C.WEB_DATA / "series").glob("*.json"))}
    res = {"backtest": backtest(all_series, names), "current": current(all_series, names)}
    (C.WEB_DATA / "warning.json").write_text(json.dumps(res, separators=(",", ":")))
    b = res["backtest"]
    jul = next(r for r in b["by_month"] if r["month"] == 7)
    print(f"warning: {b['region_years']} region-years, {b['severe']} severe; by July {jul['hits']} caught, "
          f"{jul['false_alarms']} false alarms")


if __name__ == "__main__":
    main()
