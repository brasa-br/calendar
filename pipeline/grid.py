"""Monthly hotspot grid for the animated map (web/public/data/grid.bin + grid.json).

Two layers per grid cell and month:
  raw  : the naive splice, MODIS detections until 2011 and VIIRS from 2012 on;
  harm : the harmonized record. Months observed by VIIRS are identical to `raw`. Earlier
         (and gap-filled) months use the MODIS detections of each cell scaled by the
         harmonized / MODIS ratio of the cell's biome in that month; every month is then
         rescaled to the national harmonized total. The scaling is spatially uniform within a
         biome, so the map is labelled illustrative; the official figures are the series.

Binary layout: gzip of three planes over N entries sorted by month, then cell:
  uint16 LE  cell index (row * ncols + col), delta-coded within each month;
  uint8      raw level;
  int8       harmonized level minus raw level.
Levels are log-scaled: level = round(255 * log1p(v) / log1p(vmax)); entries with both levels 0
are dropped. grid.json carries N and the month offsets into the entry list.
"""
from __future__ import annotations

import gzip
import json

import duckdb
import numpy as np
import pandas as pd

from . import config as C

STEP = 0.25
LON0, LAT0 = -74.0, -34.0
NCOLS = int(round((-28.75 - LON0) / STEP))
NROWS = int(round((5.5 - LAT0) / STEP))
VMAX_QUANTILE = 0.999
VIIRS_SOURCES = {"viirs_observed", "viirs_provisional"}


def cell_counts(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    keep = ",".join(f"'{c}'" for c in C.KEEP_CONF)
    return con.execute(f"""
    WITH b AS (
      SELECT lat2, lon2,
             max(region_id) FILTER (WHERE region_id LIKE 'BIOME_%') AS biome,
             bool_or(region_id = 'BR') AS br
      FROM memb GROUP BY 1, 2)
    SELECT d.sensor, strftime(d.date, '%Y-%m') AS ym,
           CAST(floor((d.lat - {LAT0}) / {STEP}) AS INTEGER) AS row,
           CAST(floor((d.lon - {LON0}) / {STEP}) AS INTEGER) AS col,
           coalesce(b.biome, 'BR') AS biome, count(*) AS n
    FROM det d JOIN b USING (lat2, lon2)
    WHERE b.br AND d.conf IN ({keep})
    GROUP BY ALL
    """).df()


def build(counts: pd.DataFrame, series: dict[str, dict]) -> tuple[np.ndarray, dict]:
    months = series["BR"]["months"]
    mi = {m: i for i, m in enumerate(months)}
    counts = counts[counts.ym.isin(mi)].copy()
    counts["t"] = counts.ym.map(mi).astype(int)
    counts["cell"] = counts.row * NCOLS + counts.col
    assert counts.row.between(0, NROWS - 1).all() and counts.col.between(0, NCOLS - 1).all()

    # per (biome, month) factor that maps MODIS cell counts onto the harmonized biome series
    fac, use_viirs = {}, {}
    for rid, s in series.items():
        h = np.asarray(s["harmonized"], float)
        m = np.asarray(s["modis_raw"], float)
        fac[rid] = np.where(m > 0, h / np.maximum(m, 1), 0.0)
        use_viirs[rid] = np.array([src in VIIRS_SOURCES for src in s["source"]])
    split = mi[C.OVERLAP_START]

    mod = counts[counts.sensor == "MODIS"]
    vii = counts[counts.sensor == "VIIRS"]
    f = np.array([fac[b][t] for b, t in zip(mod.biome, mod.t)])
    uv_m = np.array([use_viirs[b][t] for b, t in zip(mod.biome, mod.t)], bool)
    uv_v = np.array([use_viirs[b][t] for b, t in zip(vii.biome, vii.t)], bool)
    parts = [
        pd.DataFrame({"t": mod.t, "cell": mod.cell, "raw": np.where(mod.t < split, mod.n, 0),
                      "harm": np.where(uv_m, 0, mod.n * f)}),
        pd.DataFrame({"t": vii.t, "cell": vii.cell, "raw": np.where(vii.t >= split, vii.n, 0),
                      "harm": np.where(uv_v, vii.n, 0)}),
    ]
    g = pd.concat(parts).groupby(["t", "cell"], as_index=False)[["raw", "harm"]].sum()
    # Biome models are fitted separately from the national one; rescale each month so the map
    # adds up to the national harmonized figure shown next to it.
    tot = g.groupby("t").harm.transform("sum")
    br_h = np.asarray(series["BR"]["harmonized"], float)[g.t.values]
    g["harm"] = np.where(tot > 0, g.harm * br_h / tot.where(tot > 0, 1), 0)
    vmax = float(np.quantile(np.concatenate([g.raw[g.raw > 0], g.harm[g.harm > 0]]), VMAX_QUANTILE))
    lv = lambda v: np.clip(np.rint(255 * np.log1p(v) / np.log1p(vmax)), 0, 255).astype(np.uint8)  # noqa: E731
    g["qr"], g["qh"] = lv(g.raw.values), lv(g.harm.values)
    g = g[(g.qr > 0) | (g.qh > 0)].sort_values(["t", "cell"])

    rec = np.zeros(len(g), dtype=[("cell", "<u2"), ("raw", "u1"), ("harm", "u1")])
    rec["cell"], rec["raw"], rec["harm"] = g.cell.values, g.qr.values, g.qh.values
    offsets = np.searchsorted(g.t.values, np.arange(len(months) + 1)).tolist()
    meta = {"lon0": LON0, "lat0": LAT0, "step": STEP, "ncols": NCOLS, "nrows": NROWS,
            "months": months, "offsets": offsets, "vmax": round(vmax, 2),
            "overlap_start": C.OVERLAP_START,
            "note": "Illustrative: pre-2012 cells are MODIS scaled by their biome harmonized/MODIS ratio, then to the national total."}
    meta["n"] = len(rec)
    return rec, meta


def encode(rec: np.ndarray, offsets: list[int]) -> bytes:
    cell = rec["cell"].astype(np.int32)
    delta = cell.copy()
    for a, b in zip(offsets[:-1], offsets[1:]):
        delta[a + 1:b] = np.diff(cell[a:b])
    hdiff = rec["harm"].astype(np.int16) - rec["raw"].astype(np.int16)
    planes = delta.astype("<u2").tobytes() + rec["raw"].tobytes() + hdiff.astype(np.int8).tobytes()
    return gzip.compress(planes, compresslevel=9, mtime=0)


def main() -> None:
    series = {}
    for p in sorted((C.WEB_DATA / "series").glob("*.json")):
        if p.stem == "BR" or p.stem.startswith("BIOME_"):
            series[p.stem] = json.loads(p.read_text())
    con = duckdb.connect(str(C.INTERIM / "fire.duckdb"), read_only=True)
    rec, meta = build(cell_counts(con), series)
    (C.WEB_DATA / "grid.bin").write_bytes(encode(rec, meta["offsets"]))
    (C.WEB_DATA / "grid.json").write_text(json.dumps(meta, separators=(",", ":")))
    size = (C.WEB_DATA / "grid.bin").stat().st_size
    print(f"grid: {len(rec):,} entries, {size / 1e6:.2f} MB compressed, vmax {meta['vmax']}")


if __name__ == "__main__":
    main()
