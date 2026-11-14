import gzip

import numpy as np
import pandas as pd

from pipeline import grid as G


def _series(months, harm, modis, source):
    return {"months": months, "harmonized": harm, "modis_raw": modis, "source": source}


def test_grid_layers_and_totals():
    months = ["2011-12", "2012-01"]
    series = {
        "BR": _series(months, [40, 30], [10, 7], ["harmonized_modis", "viirs_observed"]),
        "BIOME_CER": _series(months, [40, 30], [10, 7], ["harmonized_modis", "viirs_observed"]),
    }
    counts = pd.DataFrame({
        "sensor": ["MODIS", "MODIS", "VIIRS", "MODIS"],
        "ym": ["2011-12", "2011-12", "2012-01", "2012-01"],
        "row": [10, 10, 10, 11], "col": [5, 6, 5, 5],
        "biome": ["BIOME_CER"] * 4, "n": [6, 4, 30, 7],
    })
    rec, meta = G.build(counts, series)
    assert meta["offsets"] == [0, 2, 3]
    lv = lambda v: round(255 * np.log1p(v) / np.log1p(meta["vmax"]))  # noqa: E731
    dec = {(t, int(r["cell"])): (int(r["raw"]), int(r["harm"]))
           for t in range(2) for r in rec[meta["offsets"][t]:meta["offsets"][t + 1]]}
    c = lambda row, col: row * G.NCOLS + col  # noqa: E731
    # 2011: raw is MODIS, harmonized is MODIS x (40/10), summing to the national 40
    assert dec[(0, c(10, 5))] == (lv(6), lv(24))
    assert dec[(0, c(10, 6))] == (lv(4), lv(16))
    # 2012: both layers are VIIRS; MODIS detections are not drawn
    assert dec[(1, c(10, 5))] == (lv(30), lv(30))
    assert (1, c(11, 5)) not in dec


def test_encode_roundtrip():
    rec = np.zeros(3, dtype=[("cell", "<u2"), ("raw", "u1"), ("harm", "u1")])
    rec["cell"], rec["raw"], rec["harm"] = [5, 900, 7], [10, 0, 255], [40, 3, 200]
    buf = gzip.decompress(G.encode(rec, [0, 2, 3]))
    n = len(rec)
    delta = np.frombuffer(buf[:2 * n], "<u2")
    raw = np.frombuffer(buf[2 * n:3 * n], "u1")
    diff = np.frombuffer(buf[3 * n:], "i1")
    assert delta.tolist() == [5, 895, 7]
    assert raw.tolist() == [10, 0, 255]
    assert (raw.astype(int) + diff).tolist() == [40, 3, 200]
