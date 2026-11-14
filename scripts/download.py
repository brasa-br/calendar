"""Download NASA FIRMS yearly country CSVs (Brazil) for MODIS and VIIRS S-NPP.

Resumable: skips files whose size matches the server Content-Length.
Order: overlap years (2012-2025) first, then MODIS 2000-2011.
"""
from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "firms"
UA = {"User-Agent": "brasa-pipeline/0.1"}


def jobs() -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for y in range(2012, 2026):
        out += [("modis", y), ("viirs-snpp", y)]
    for y in range(2000, 2012):
        out.append(("modis", y))
    return out


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        cl = r.headers.get("Content-Length")
        return int(cl) if cl else None


def fetch(url: str, dest: Path, size: int | None) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    have = tmp.stat().st_size if tmp.exists() else 0
    headers = dict(UA)
    if have and size and have < size:
        headers["Range"] = f"bytes={have}-"
    else:
        have = 0
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "ab" if have else "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if size and tmp.stat().st_size != size:
        raise IOError(f"size mismatch {tmp.stat().st_size} != {size}")
    tmp.rename(dest)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failed = []
    for product, year in jobs():
        name = f"{product}_{year}_Brazil.csv"
        url = f"{BASE}/{product}/{year}/{name}"
        dest = OUT / name
        for attempt in range(5):
            try:
                size = remote_size(url)
                if dest.exists() and (size is None or dest.stat().st_size == size):
                    print(f"skip {name}", flush=True)
                    break
                t = time.time()
                fetch(url, dest, size)
                print(f"ok   {name} {dest.stat().st_size/1e6:.1f} MB {time.time()-t:.0f}s", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"retry {name} ({attempt+1}/5): {e}", flush=True)
                time.sleep(5 * (attempt + 1))
        else:
            failed.append(name)
    print("DONE" if not failed else f"FAILED: {failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
