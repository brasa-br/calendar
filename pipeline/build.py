"""FIRMS CSVs -> filtered, deduplicated detections -> monthly counts per region/sensor/platform.

Outputs (data/interim/):
  monthly.parquet   region_id, sensor, platform, ym, n, n_all, n_day, fire_days
  coverage.parquet  sensor, platform, ym, days_with_detections
  versions.parquet  sensor, year, version, n
  build_meta.json
"""
from __future__ import annotations

import json
import time

import duckdb

from . import config as C
from .regions import build_lookup, load_boundaries

CONF_SQL_MODIS = (
    f"CASE WHEN TRY_CAST(confidence AS INTEGER) < {C.MODIS_CONF_LOW_MAX} THEN 'low' "
    f"WHEN TRY_CAST(confidence AS INTEGER) >= {C.MODIS_CONF_HIGH_MIN} THEN 'high' ELSE 'nominal' END"
)
CONF_SQL_VIIRS = "CASE lower(confidence) WHEN 'l' THEN 'low' WHEN 'h' THEN 'high' ELSE 'nominal' END"


def _src(product: str) -> str:
    return str(C.RAW / f"{product}_*_Brazil.csv")


def normalize(con: duckdb.DuckDBPyConnection) -> None:
    opts = "union_by_name=true, types={'confidence':'VARCHAR','version':'VARCHAR','acq_time':'VARCHAR','satellite':'VARCHAR'}"
    types = ",".join(str(t) for t in C.KEEP_TYPES)
    con.execute(f"""
    CREATE OR REPLACE TABLE det AS
    SELECT DISTINCT sensor, platform, lat, lon, date, acq_time, conf, daynight, version
    FROM (
      SELECT 'MODIS' AS sensor, satellite AS platform, latitude AS lat, longitude AS lon,
             CAST(acq_date AS DATE) AS date, lpad(acq_time, 4, '0') AS acq_time,
             {CONF_SQL_MODIS} AS conf, daynight, CAST(version AS VARCHAR) AS version
      FROM read_csv('{_src("modis")}', {opts})
      WHERE TRY_CAST(type AS INTEGER) IN ({types})
      UNION ALL
      SELECT 'VIIRS', 'S-NPP', latitude, longitude, CAST(acq_date AS DATE), lpad(acq_time, 4, '0'),
             {CONF_SQL_VIIRS}, daynight, CAST(version AS VARCHAR)
      FROM read_csv('{_src("viirs-snpp")}', {opts})
      WHERE TRY_CAST(type AS INTEGER) IN ({types})
    )
    """)
    con.execute(f"""
    ALTER TABLE det ADD COLUMN lat2 DOUBLE; ALTER TABLE det ADD COLUMN lon2 DOUBLE;
    UPDATE det SET lat2 = round(lat, {C.LOOKUP_ROUND}), lon2 = round(lon, {C.LOOKUP_ROUND});
    """)


def assign_regions(con: duckdb.DuckDBPyConnection) -> None:
    coords = con.execute("SELECT DISTINCT lat2 AS lat, lon2 AS lon FROM det").df()
    print(f"  unique coords: {len(coords):,}", flush=True)
    lk = build_lookup(coords, load_boundaries())
    con.register("lk_df", lk)
    con.execute("""
    CREATE OR REPLACE TABLE memb AS
      SELECT lat AS lat2, lon AS lon2, 'BR' AS region_id FROM lk_df WHERE uf IS NOT NULL
      UNION ALL SELECT lat, lon, 'UF_' || uf FROM lk_df WHERE uf IS NOT NULL
      UNION ALL SELECT lat, lon, 'BIOME_' || biome FROM lk_df WHERE uf IS NOT NULL AND biome IS NOT NULL
      UNION ALL SELECT lat, lon, 'RMC' FROM lk_df WHERE uf IS NOT NULL AND is_rmc
    """)


def aggregate(con: duckdb.DuckDBPyConnection) -> dict:
    keep = ",".join(f"'{c}'" for c in C.KEEP_CONF)
    cell = C.FIREDAY_CELL
    con.execute(f"""
    COPY (
      SELECT m.region_id, d.sensor, d.platform, strftime(d.date, '%Y-%m') AS ym,
             count(*) FILTER (WHERE d.conf IN ({keep})) AS n,
             count(*) AS n_all,
             count(*) FILTER (WHERE d.conf IN ({keep}) AND d.daynight = 'D') AS n_day,
             count(DISTINCT (floor(d.lat/{cell}), floor(d.lon/{cell}), d.date))
               FILTER (WHERE d.conf IN ({keep})) AS fire_days
      FROM det d JOIN memb m USING (lat2, lon2)
      GROUP BY ALL
    ) TO '{C.INTERIM / "monthly.parquet"}' (FORMAT parquet)
    """)
    con.execute(f"""
    COPY (SELECT sensor, platform, strftime(date, '%Y-%m') AS ym, count(DISTINCT date) AS days
          FROM det GROUP BY ALL) TO '{C.INTERIM / "coverage.parquet"}' (FORMAT parquet)
    """)
    con.execute(f"""
    COPY (SELECT sensor, year(date) AS year, version, count(*) AS n FROM det GROUP BY ALL)
    TO '{C.INTERIM / "versions.parquet"}' (FORMAT parquet)
    """)
    total, dropped = con.execute("""
      SELECT count(*), count(*) FILTER (WHERE NOT EXISTS
        (SELECT 1 FROM memb m WHERE m.lat2=d.lat2 AND m.lon2=d.lon2 AND m.region_id='BR'))
      FROM det d
    """).fetchone()
    by_sensor = dict(con.execute("SELECT sensor, count(*) FROM det GROUP BY 1").fetchall())
    span = con.execute("SELECT sensor, min(date)::VARCHAR, max(date)::VARCHAR FROM det GROUP BY 1").fetchall()
    return {"detections_type0_dedup": int(total), "dropped_outside_states": int(dropped),
            "by_sensor": {k: int(v) for k, v in by_sensor.items()},
            "date_span": {s: [a, b] for s, a, b in span}}


def main() -> None:
    C.INTERIM.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    con = duckdb.connect(str(C.INTERIM / "fire.duckdb"))
    con.execute("SET preserve_insertion_order=false")
    print("normalize...", flush=True)
    normalize(con)
    print(f"  {time.time()-t0:.0f}s; regions...", flush=True)
    assign_regions(con)
    print(f"  {time.time()-t0:.0f}s; aggregate...", flush=True)
    meta = aggregate(con)
    meta["filters"] = {"types": list(C.KEEP_TYPES), "confidence": list(C.KEEP_CONF),
                       "modis_conf_low_lt": C.MODIS_CONF_LOW_MAX, "modis_conf_high_ge": C.MODIS_CONF_HIGH_MIN}
    (C.INTERIM / "build_meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
