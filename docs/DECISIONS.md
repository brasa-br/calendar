# Decisions

- **Harmonization target is VIIRS-equivalent counts.** VIIRS is the successor sensor, so the record stays valid after MODIS is retired.
- **Yearly FIRMS country archives** instead of the API: no key required, and the files can be downloaded again from the same URLs.
- **One model for all regions (C4).** It was selected by mean cross-validated RMSE in log space. It is practically tied with C3; both beat single ratios (C1/C2) on error but carry about +5% bias.
- **Degraded months** (< 80% of days with detections nationally) are excluded from fitting. VIIRS gaps are filled from calibrated MODIS.
- **Calendar starts in 2001**, the first full year of MODIS. Nov–Dec 2000 remain in the data files.
- **Static site with no tile provider:** the map is drawn from local TopoJSON, so it needs no keys and has no external runtime dependency.
- **Polygon winding is corrected client-side** before d3-geo projection, because spherical winding otherwise fills the globe.
