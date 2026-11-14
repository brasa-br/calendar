import datetime as dt
import importlib.util
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fetch_nrt", ROOT / "scripts" / "fetch_nrt.py")
nrt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nrt)

from pipeline.export import last_complete_month  # noqa: E402


def test_segments_prefer_sp_then_nrt():
    d = dt.date
    segs = nrt.segments(2026, (d(2000, 11, 1), d(2026, 6, 30)), (d(2026, 5, 1), d(2026, 11, 13)), d(2026, 11, 14))
    assert segs == [("SP", d(2026, 1, 1), d(2026, 6, 30)), ("NRT", d(2026, 7, 1), d(2026, 11, 13))]


def test_segments_nrt_only_and_none():
    d = dt.date
    assert nrt.segments(2026, None, (d(2026, 9, 1), d(2026, 11, 13)), d(2026, 11, 14)) == [
        ("NRT", d(2026, 9, 1), d(2026, 11, 13))]
    assert nrt.segments(2026, None, None, d(2026, 11, 14)) == []


def test_archive_layout_masks_static_cells_and_names_satellites():
    raw = pd.DataFrame({
        "latitude": [-10.001, -20.5], "longitude": [-50.0, -45.25], "brightness": [320, 330],
        "scan": [1, 1], "track": [1, 1], "acq_date": ["2026-08-01"] * 2, "acq_time": ["130", "1345"],
        "satellite": ["T", "A"], "instrument": ["MODIS"] * 2, "confidence": ["50", "90"],
        "version": ["6.1NRT"] * 2, "bright_t31": [300, 301], "frp": [10, 20], "daynight": ["D", "D"],
    })
    out = nrt.to_archive_layout(raw, "modis", {(-10.0, -50.0)})
    assert list(out.columns) == nrt.ARCHIVE_COLS["modis"]
    assert out["type"].tolist() == [2, 0]
    assert out["satellite"].tolist() == ["Terra", "Aqua"]
    assert out["acq_time"].tolist() == ["0130", "1345"]


def test_last_complete_month():
    assert last_complete_month("2025-12-31") == "2025-12"
    assert last_complete_month("2026-11-13") == "2026-10"
    assert last_complete_month("2026-10-31") == "2026-10"
