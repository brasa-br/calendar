export type SeriesKey = "harmonized" | "modis" | "viirs" | "naive";
export type ViewKey = "counts" | "anomaly";

export interface Region {
  id: string;
  name: string;
  kind: "country" | "biome" | "state" | "metro";
  parent: string | null;
}

export interface Series {
  region: string;
  model: string;
  model_source: string;
  months: string[];
  harmonized: number[];
  lo: number[];
  hi: number[];
  source: string[];
  modis_raw: number[];
  viirs_raw: (number | null)[];
  naive: number[];
  qa_flag: number[];
}

export interface Meta {
  generated_utc: string;
  selected_model: string;
  k_global_viirs_per_modis: number;
  calibration_months: number;
  cv_summary: Record<string, { rmse_log: number; r2_log: number; mape_ge50: number; bias: number; mean_abs_bias: number }>;
  proof: {
    annual: { years: number[]; harmonized: number[]; lo: number[]; hi: number[]; modis_raw: number[]; naive: number[] };
    naive: Proof;
    harmonized: Proof;
    modis_raw: Proof;
  };
  sensitivity_br_ratio: Record<string, number>;
  build: { detections_type0_dedup: number; by_sensor: Record<string, number> };
  qa: { degraded_months: { sensor: string; platform: string; ym: string; days: number }[] };
}

interface Proof {
  step_2012: number;
  pettitt: { change_year: number; p: number };
  trend: { trend: string; p: number; sen_slope_per_year: number; sen_slope_pct_of_mean: number };
}

export interface Validation {
  model: string;
  points: { region: string; ym: string; obs: number; pred: number }[];
}

const cache = new Map<string, Promise<Series>>();

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`./data/${path}`);
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return res.json() as Promise<T>;
}

export const loadRegions = () => getJSON<Region[]>("regions.json");
export const loadMeta = () => getJSON<Meta>("meta.json");
export const loadValidation = () => getJSON<Validation>("validation.json");
export const loadBoundaries = () => getJSON<unknown>("boundaries.topo.json");

export function loadSeries(id: string): Promise<Series> {
  let p = cache.get(id);
  if (!p) {
    p = getJSON<Series>(`series/${id}.json`);
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

/** Value of the chosen series for month index i (null = no data for that sensor). */
export function valueAt(s: Series, key: SeriesKey, i: number): number | null {
  switch (key) {
    case "harmonized":
      return s.harmonized[i];
    case "modis":
      return s.modis_raw[i];
    case "viirs":
      return s.viirs_raw[i];
    case "naive":
      return s.naive[i];
  }
}

export const isEstimated = (src: string) => src !== "viirs_observed";

export const SOURCE_LABEL: Record<string, string> = {
  viirs_observed: "Observed by VIIRS",
  harmonized_modis: "Estimated from MODIS",
  modis_terra_adjusted: "Estimated from MODIS (Terra only, adjusted for Aqua)",
  modis_gapfill: "VIIRS gap filled from MODIS",
};

export const SERIES_LABEL: Record<SeriesKey, string> = {
  harmonized: "Harmonized",
  modis: "MODIS raw",
  viirs: "VIIRS raw",
  naive: "Naive splice",
};

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FIRST_YEAR = 2001;
export const LAST_YEAR = 2025;
