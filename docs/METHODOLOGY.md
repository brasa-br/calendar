# Methodology

All parameters live in `pipeline/config.py`; every number below is produced by the pipeline and stored in `web/public/data/meta.json`.

## 1. Data

NASA FIRMS yearly country archives for Brazil:

- **MODIS** Collection 6.1 (Terra from Nov 2000, Aqua from Jul 2002), 1 km, 2000–2025.
- **VIIRS** S-NPP 375 m (VNP14IMG), 2012–2025.

Columns used: `latitude, longitude, acq_date, acq_time, satellite, confidence, daynight, type, version`.

## 2. Cleaning

| Step | Rule | Why |
|---|---|---|
| Fire type | `type = 0` | Removes volcanoes (1), static land sources such as industry (2), and offshore detections (3) |
| Confidence | MODIS ≥ 30; VIIRS `n` or `h` | Standard low-confidence cut; mapped to a common low/nominal/high class (MODIS: < 30 low, 30–79 nominal, ≥ 80 high) |
| Duplicates | identical sensor, platform, position, date and time | Defensive |
| Region | point-in-polygon on coordinates rounded to 0.01° | IBGE states, biomes ("Sistema Costeiro" excluded) and Campinas Metro Area municipalities |

20,833 detections fell outside state polygons (coast, borders) and were dropped.

## 3. Coverage quality

For each platform and month we count the days with at least one detection in Brazil. Months under 80% are flagged:

- VIIRS: Jan 2012 (instrument start), Aug 2022, Jul 2024.
- Aqua: Aug 2002, Apr 2022.
- Terra: Jun 2001, Mar 2002, Dec 2003, Feb 2016, Oct 2022.

Flagged months are excluded from calibration. When VIIRS is degraded and MODIS is not, the harmonized value comes from calibrated MODIS (`source = modis_gapfill`).

## 4. Terra-only adjustment

Aqua became fully operational in mid-2002, so a raw MODIS series jumps when Aqua is added. For each region and calendar month we fit `k_TA = Σ(Terra + Aqua) / Σ Terra` over 2003–2011 and multiply Terra counts by `k_TA` for Nov 2000 to Aug 2002. Regions with fewer than 200 Terra detections in a calendar month inherit the parent region's ratio.

## 5. Calibration models

Fitted per region on the clean overlap months (2012–2025, n = 162), with `M` = homogenized MODIS and `V` = VIIRS:

- **C0:** `V = M` (no harmonization; baseline)
- **C1:** `V = k·M`, one `k` for Brazil
- **C2:** `V = k_r·M`, ratio per region; interval from the 5th/95th percentiles of the log residual ratio
- **C3:** `log(1+V) = a_r + b_r·log(1+M)`, OLS. Point estimates are back-transformed with Duan's smearing; the 90% prediction interval is back-transformed directly.
- **C4:** C3 plus a dummy for the region's 4 peak fire months

Regions with fewer than 1,000 VIIRS detections, or fewer than 60 non-zero MODIS months, fall back to their parent region's C2 ratio. No region needed the fallback in this run.

### Model selection

Two-fold blocked temporal cross-validation: train 2012–2018 and test 2019–2025, then the reverse. Metrics are averaged over 35 regions × 2 folds. The selected model is the one with the lowest mean RMSE in log space.

| Model | RMSE (log) | R² (log) | MAPE (months ≥ 50) | Mean absolute bias |
|---|---|---|---|---|
| C0 | 1.389 | −0.336 | 72.6% | 73.7% |
| C1 | 0.466 | 0.858 | 30.1% | 8.0% |
| C2 | 0.462 | 0.862 | 29.7% | 8.7% |
| C3 | 0.344 | 0.931 | 24.4% | 10.1% |
| **C4** | **0.343** | **0.932** | 24.6% | 10.3% |

Cross-validated R² (log) by region with C4: Brazil 0.986; biomes 0.888 (Pampa) to 0.981 (Pantanal); São Paulo state 0.947; Campinas Metro Area 0.676.

## 6. Proof of harmonization (Brazil, annual totals 2001–2025)

| Series | Step ratio (mean 2012–14 / mean 2009–11) | Pettitt change point | Mann-Kendall | Sen's slope |
|---|---|---|---|---|
| Naive splice | 3.19 | 2012, p = 0.0003 | increasing, p = 0.0003 | +5.6% of mean per year |
| Harmonized | 0.84 | 2008, p = 0.03 | decreasing, p = 0.038 | −2.1% of mean per year |
| MODIS only | 0.84 | 2008, p = 0.21 | no trend, p = 0.18 | −1.6% of mean per year |

The harmonized step ratio equals the single-sensor MODIS ratio. In other words, the remaining change around 2012 is real variation in fire activity, not the sensor switch.

## 7. Sensitivity

The VIIRS/MODIS ratio for Brazil over the calibration months:

| Variant | Ratio |
|---|---|
| Default (nominal + high confidence, day + night) | 3.77 |
| Including low confidence | 3.92 |
| Daytime only | 3.24 |
| Fire-days on a 0.1° grid instead of pixel counts | 2.11 |

The grid-based ratio is much smaller. That suggests a large part of the VIIRS excess comes from one fire lighting several 375 m pixels, not only from small fires that MODIS misses.

## 8. Current year (provisional)

The yearly country archives exist only for finished years. `scripts/fetch_nrt.py` fills the current year from the FIRMS Area API over a Brazil bounding box. It uses standard-processing data (MODIS_SP, VIIRS_SNPP_SP) where FIRMS already has it and near-real-time data (MODIS_NRT, VIIRS_SNPP_NRT) after that, then writes files in the archive layout so the pipeline is unchanged.

- **No fire-type field.** API rows have no `type` column. Detections in 0.01° cells flagged as static land sources (type 2) in the previous three archive years are marked as type 2 and dropped by the normal filter. The rest are treated as vegetation fires. A new industrial heat source would therefore be counted until it appears in an archive.
- **Only complete months.** The series ends at the last complete month of VIIRS data.
- **Provisional months are never used to fit the models.** The calibration window stays 2012–2025, so the coefficients, cross-validation and proof statistics do not change when provisional months are added. Running the pipeline with and without ten provisional months gave identical calibration ratios.
- **Labelled everywhere.** These months have `source = viirs_provisional`. They are drawn with a dashed outline in the calendar and left out of annual totals and trend tests.

## 9. Early-warning comparison

For the last year of the selection (the focus year), the site adds up hotspots month by month and compares each running total with the same point in every complete earlier year of the selection.

- **Median year:** the median of those earlier running totals, month by month.
- **Rank:** how many earlier years had more hotspots by the latest month with data.
- **Ahead since:** the first month from which the focus year stays above every earlier year through the latest month.
- **Month records:** months whose single-month count exceeds the same month in every earlier year.

At least five complete earlier years are required. Only years before the focus year are compared, so a past year is judged with the information that existed at the time. The calibration coefficients are the exception, since they come from 2012–2025.

## 10. Known limitations

See the README. In short: hotspots are not burned area; pre-2012 values are estimates with stated intervals; orbit drift; MODIS archive version changes; current-year months are provisional.
