# FireCalendar

**25 years of fire in Brazil, one consistent record.** FireCalendar harmonizes NASA's two satellite fire records, MODIS (2000 to today) and VIIRS (2012 to today), into a single month-by-month calendar for Brazil, its 6 biomes, its 27 states and the Campinas Metro Area.

- **Live site:** _add GitHub Pages URL_
- **Demo video (30 s):** _add link_
- **Challenge:** NASA Space Apps Challenge 2026, [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/)

## The problem

VIIRS has 375 m pixels; MODIS has 1 km pixels. VIIRS sees smaller fires, so in Brazil it reports **3.77×** as many hotspots as MODIS over the same months. Joining the two records naively makes fire activity appear to **jump 3.2× in 2012**, and turns a flat or falling record into a false rising trend of **+5.6% per year** (Mann-Kendall p < 0.001). The jump is the sensor, not the fires.

## What FireCalendar does

1. **Calendar heatmap** (years × months) of hotspots for any region and period, with the peak month, the typical fire season and the long-term trend (Mann-Kendall + Sen's slope).
2. **Four views of the same data:** harmonized, naive splice, MODIS only and VIIRS only. Switching between them shows the 2012 artefact appear and disappear.
3. **Uncertainty is visible.** Months estimated from MODIS carry a marker and a 90% prediction interval; months with reduced satellite coverage are hatched.
4. **Map** of states or biomes; click to open a calendar.
5. **CSV download** of the current selection, plus the full dataset for all 35 regions.
6. **Accessible:** colour-blind-safe sequential (YlOrRd) and diverging (PuOr) scales, keyboard navigation of the calendar, and a table version of every calendar.

## NASA data used

| Dataset | Use |
|---|---|
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) MODIS Collection 6.1 active fires, Terra + Aqua, yearly country files for Brazil, 2000–2025 (`/data/country/modis/YYYY/modis_YYYY_Brazil.csv`) | The long record (2000–2011) and the calibration partner for VIIRS |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) VIIRS S-NPP 375 m active fires, yearly country files for Brazil, 2012–2025 (`/data/country/viirs-snpp/YYYY/viirs-snpp_YYYY_Brazil.csv`) | The modern record and the harmonization target |

Accessed 14 November 2026. 28,844,913 vegetation-fire detections after cleaning (18,987,187 VIIRS; 9,857,726 MODIS).

**Other data:** IBGE state (2020), biome (2019) and metropolitan-area (2018) boundaries, through the [geobr](https://github.com/ipeaGIT/geobr) package.

## Method (summary)

Full details: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

1. **Clean:** keep `type = 0` (presumed vegetation fire) and nominal/high confidence; remove exact duplicates.
2. **Assign** each detection to a state, a biome and the Campinas Metro Area.
3. **Terra-only months** (Nov 2000 to Aug 2002, before Aqua was fully operational) are scaled by the Terra → Terra+Aqua ratio, fitted on 2003–2011 per calendar month and region.
4. **Calibrate** MODIS to VIIRS on the 162 clean months in which both flew (2012–2025). Five models were compared with two-fold temporal cross-validation (train 2012–2018, test 2019–2025, and the reverse):

| Model | RMSE (log) | R² (log) | Mean absolute bias |
|---|---|---|---|
| C0, no harmonization | 1.39 | −0.34 | 74% |
| C1, one ratio for Brazil | 0.47 | 0.86 | 8% |
| C2, one ratio per region | 0.46 | 0.86 | 9% |
| C3, log-log per region | 0.34 | 0.93 | 10% |
| **C4, log-log per region + fire-season term (used)** | **0.34** | **0.93** | 10% |

5. **Back-cast** 2001–2011 with 90% prediction intervals. Months where VIIRS coverage was degraded (Jan 2012, Aug 2022, Jul 2024) are left out of the fit and filled from calibrated MODIS.

## Results

| Brazil, annual 2001–2025 | Step 2009–11 → 2012–14 | Change point (Pettitt) | Trend (Mann-Kendall) |
|---|---|---|---|
| Naive splice | **3.19×** | 2012 (p < 0.001) | +5.6%/yr, p < 0.001 |
| Harmonized | **0.84×** | none at 2012 | −2.1%/yr, p = 0.038 |
| MODIS only (reference) | 0.84× | none at 2012 | −1.6%/yr, p = 0.18 |

After harmonization the 2012 step matches MODIS alone, and the false rising trend disappears.

## Limitations

- Hotspots are active-fire pixels at satellite overpass time, not burned area. Clouds hide fires.
- Pre-2012 values are model estimates. Intervals are wide where fires are rare (e.g. the Campinas Metro Area, cross-validated R² = 0.68, compared with 0.96–0.99 for biomes).
- The log-log models (C3/C4) have the lowest error but a slight positive bias (about +5%); single ratios (C1/C2) are less biased but noisier. C3 and C4 are practically tied.
- Orbit drift of Terra and Aqua changes overpass times in recent years; the VIIRS/MODIS ratio falls slightly after 2022.
- MODIS product versions in the FIRMS archive change over time (6.2, then 6.03 from 2018, then 61.03 from 2023).
- 2026 is not included: the yearly archive is published after the year ends.

## Reproduce

Requires Python 3.11+, [uv](https://github.com/astral-sh/uv) and Node 20+.

```bash
make setup      # Python env + web dependencies
make data       # downloads ~2.2 GB of FIRMS CSVs into data/raw (not versioned)
make pipeline   # builds monthly series, harmonizes, validates, writes web/public/data
make test
make dev        # local site
```

The pipeline runs in about 90 seconds on a laptop (DuckDB).

## Project structure

```
scripts/download.py     FIRMS downloader (resumable)
pipeline/build.py       CSV → cleaned detections → monthly counts per region (DuckDB)
pipeline/harmonize.py   Terra/Aqua adjustment, calibration models, prediction intervals
pipeline/validate.py    Pettitt, Mann-Kendall, step ratio
pipeline/export.py      cross-validation, final fits, JSON/CSV for the site
web/                    static site (Vite, TypeScript, Observable Plot, d3)
```

## Tools and licences

DuckDB, pandas, NumPy, GeoPandas, Shapely, statsmodels, pymannkendall, geobr, topojson (Python); Vite, TypeScript, D3, Observable Plot, topojson-client (web). Public Sans typeface (SIL Open Font License). Space Apps logo used as provided by the challenge organizers; no NASA insignia is used.

Code: MIT licence. FIRMS data: NASA open data.

_Not an official NASA product._
