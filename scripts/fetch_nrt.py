"""Fetch the current year's MODIS and VIIRS S-NPP detections for Brazil from the FIRMS Area API.

The yearly country archives used by scripts/download.py only exist for finished years. For the
current year this script pulls standard-processing (SP) data where FIRMS already has it and
near-real-time (NRT) data after that, then writes files in the archive layout
(data/raw/firms/{modis,viirs-snpp}_YYYY_Brazil.csv) so `make pipeline` picks them up unchanged.
The pipeline marks every month after the calibration window as provisional.

Needs a free FIRMS MAP_KEY (https://firms.modaps.eosdis.nasa.gov/api/map_key/) in the
environment or in .env as FIRMS_MAP_KEY. The key is never written to any output file.

Usage: python scripts/fetch_nrt.py [--year 2026]
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "firms"
CHUNKS = RAW / "api_chunks"
API = "https://firms.modaps.eosdis.nasa.gov/api"
BBOX = "-74,-34,-34,6"  # Brazil; the pipeline clips to IBGE state boundaries afterwards
DAY_RANGE = 5           # API maximum
UA = {"User-Agent": "firecalendar-pipeline/0.1"}

PRODUCTS = {
    "modis": ("MODIS_SP", "MODIS_NRT"),
    "viirs-snpp": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
}
ARCHIVE_COLS = {
    "modis": ["latitude", "longitude", "brightness", "scan", "track", "acq_date", "acq_time", "satellite",
              "instrument", "confidence", "version", "bright_t31", "frp", "daynight", "type"],
    "viirs-snpp": ["latitude", "longitude", "bright_ti4", "scan", "track", "acq_date", "acq_time", "satellite",
                   "instrument", "confidence", "version", "bright_ti5", "frp", "daynight", "type"],
}
SATELLITE = {"T": "Terra", "A": "Aqua", "N": "N"}


def map_key() -> str:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("FIRMS_MAP_KEY is not set. Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ "
                 "and put FIRMS_MAP_KEY=... in .env")
    return key


def get(url: str, retries: int = 5) -> str:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                body = r.read().decode("utf-8")
            if body.lstrip().lower().startswith(("invalid", "error")):
                raise ValueError(body.strip()[:200])
            return body
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry ({attempt + 1}/{retries}): {str(e).split(API)[0][:120]}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("unreachable")


def availability(key: str) -> dict[str, tuple[dt.date, dt.date]]:
    df = pd.read_csv(io.StringIO(get(f"{API}/data_availability/csv/{key}/ALL")))
    df.columns = [c.strip().lower() for c in df.columns]
    out = {}
    for _, r in df.iterrows():
        try:
            out[str(r["data_id"]).strip()] = (pd.to_datetime(r["min_date"]).date(), pd.to_datetime(r["max_date"]).date())
        except (KeyError, ValueError):
            continue
    return out


def segments(year: int, sp: tuple[dt.date, dt.date] | None, nrt: tuple[dt.date, dt.date] | None,
             today: dt.date) -> list[tuple[str, dt.date, dt.date]]:
    """Split [Jan 1, yesterday] into an SP part (where SP exists) and an NRT part (the rest)."""
    start, end = dt.date(year, 1, 1), min(dt.date(year, 12, 31), today - dt.timedelta(days=1))
    segs = []
    cursor = start
    if sp and sp[1] >= start:
        a, b = max(start, sp[0]), min(end, sp[1])
        if a <= b:
            segs.append(("SP", a, b))
            cursor = b + dt.timedelta(days=1)
    if nrt and cursor <= end:
        a, b = max(cursor, nrt[0]), min(end, nrt[1])
        if a <= b:
            segs.append(("NRT", a, b))
    return segs


def fetch_segment(key: str, source: str, a: dt.date, b: dt.date, refresh_after: dt.date) -> list[pd.DataFrame]:
    CHUNKS.mkdir(parents=True, exist_ok=True)
    frames, d = [], a
    while d <= b:
        n = min(DAY_RANGE, (b - d).days + 1)
        f = CHUNKS / f"{source}_{d.isoformat()}_{n}.csv"
        last_day = d + dt.timedelta(days=n - 1)
        if not f.exists() or last_day >= refresh_after:  # recent NRT days are reprocessed by FIRMS
            body = get(f"{API}/area/csv/{key}/{source}/{BBOX}/{n}/{d.isoformat()}")
            f.write_text(body)
            time.sleep(1)
        txt = f.read_text()
        if txt.strip():
            frames.append(pd.read_csv(io.StringIO(txt), dtype={"acq_time": str, "version": str, "confidence": str}))
        print(f"  {source} {d} +{n}d", flush=True)
        d += dt.timedelta(days=n)
    return frames


def static_cells(product: str, year: int) -> set[tuple[float, float]]:
    """0.01° cells flagged as static land sources (type 2) in the last three archive years."""
    cells: set[tuple[float, float]] = set()
    for y in range(year - 3, year):
        p = RAW / f"{product}_{y}_Brazil.csv"
        if p.exists():
            d = pd.read_csv(p, usecols=["latitude", "longitude", "type"])
            d = d[d["type"] == 2]
            cells |= set(zip(d.latitude.round(2), d.longitude.round(2)))
    return cells


def to_archive_layout(df: pd.DataFrame, product: str, cells: set[tuple[float, float]]) -> pd.DataFrame:
    """API rows -> archive columns. NRT has no `type`: mark known static-source cells as 2, the rest 0."""
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    if "satellite" in df:
        df["satellite"] = df["satellite"].astype(str).map(lambda s: SATELLITE.get(s, s))
    # SP rows may carry `type` while NRT rows do not; fill row by row so mixed frames keep both.
    known = pd.to_numeric(df["type"], errors="coerce") if "type" in df else pd.Series(float("nan"), index=df.index)
    guess = pd.Series([2 if k in cells else 0 for k in zip(df.latitude.round(2), df.longitude.round(2))], index=df.index)
    df["type"] = known.fillna(guess).astype(int)
    df["acq_time"] = df["acq_time"].astype(str).str.zfill(4)
    for c in ARCHIVE_COLS[product]:
        if c not in df:
            df[c] = pd.NA
    return df[ARCHIVE_COLS[product]].drop_duplicates()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=dt.date.today().year)
    args = ap.parse_args()
    key = map_key()
    today = dt.date.today()
    avail = availability(key)
    provenance = {"year": args.year, "fetched_utc": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"),
                  "bbox": BBOX, "products": {}}
    for product, (sp_id, nrt_id) in PRODUCTS.items():
        segs = segments(args.year, avail.get(sp_id), avail.get(nrt_id), today)
        if not segs:
            print(f"{product}: no {args.year} data available yet")
            continue
        frames = []
        for kind, a, b in segs:
            src = sp_id if kind == "SP" else nrt_id
            print(f"{product}: {src} {a} to {b}", flush=True)
            frames += fetch_segment(key, src, a, b, refresh_after=today - dt.timedelta(days=7))
        if not frames:
            continue
        out = to_archive_layout(pd.concat(frames, ignore_index=True), product, static_cells(product, args.year))
        dest = RAW / f"{product}_{args.year}_Brazil.csv"
        out.to_csv(dest, index=False)
        provenance["products"][product] = {
            "segments": [{"source": sp_id if k == "SP" else nrt_id, "from": a.isoformat(), "to": b.isoformat()}
                         for k, a, b in segs],
            "rows": len(out), "static_masked": int((out["type"] == 2).sum()),
        }
        print(f"wrote {dest.name}: {len(out):,} rows", flush=True)
    (RAW / f"provisional_{args.year}.json").write_text(json.dumps(provenance, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
