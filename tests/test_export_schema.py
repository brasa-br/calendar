import json
from pathlib import Path

import pytest

D = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
KEYS = ["harmonized", "lo", "hi", "source", "modis_raw", "viirs_raw", "naive", "qa_flag"]


@pytest.mark.skipif(not (D / "regions.json").exists(), reason="pipeline output not built")
def test_series_schema():
    regs = json.loads((D / "regions.json").read_text())
    assert len(regs) == 35
    for r in regs:
        s = json.loads((D / "series" / f"{r['id']}.json").read_text())
        n = len(s["months"])
        assert s["months"][0] == "2000-11"
        for k in KEYS:
            assert len(s[k]) == n, (r["id"], k)
        assert all(x >= 0 for x in s["harmonized"])
        assert all(lo <= h <= hi for lo, h, hi in zip(s["lo"], s["harmonized"], s["hi"]))
