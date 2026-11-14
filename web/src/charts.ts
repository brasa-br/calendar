import * as Plot from "@observablehq/plot";
import { isEstimated, type Meta, type Series, type SeriesKey, valueAt, type Validation, SERIES_LABEL } from "./data";
import { fmtInt } from "./stats";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface AnnualRow {
  year: number;
  value: number;
  lo: number;
  hi: number;
  estimated: boolean;
}

export function annualRows(s: Series, key: SeriesKey, from: number, to: number): AnnualRow[] {
  const rows: AnnualRow[] = [];
  for (let y = from; y <= to; y++) {
    let v = 0, lo = 0, hi = 0, est = false, any = false;
    s.months.forEach((m, i) => {
      if (+m.slice(0, 4) !== y) return;
      const x = valueAt(s, key, i);
      if (x === null) return;
      any = true;
      v += x;
      if (key === "harmonized") {
        lo += s.lo[i];
        hi += s.hi[i];
        est ||= isEstimated(s.source[i]) && s.source[i] !== "modis_gapfill";
      }
    });
    if (any) rows.push({ year: y, value: v, lo: key === "harmonized" ? lo : v, hi: key === "harmonized" ? hi : v, estimated: est });
  }
  return rows;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function renderAnnual(host: HTMLElement, rows: AnnualRow[], key: SeriesKey, sen: { slope: number; p: number } | null): void {
  const width = Math.max(320, host.clientWidth);
  // Sen's line: intercept is the median of (y − slope·x), the standard companion to the median slope.
  const intercept = sen && rows.length ? median(rows.map((r) => r.value - sen.slope * r.year)) : 0;
  const trendLine = sen ? rows.map((r) => ({ year: r.year, value: intercept + sen.slope * r.year })) : [];
  const chart = Plot.plot({
    width,
    height: 240,
    marginLeft: 64,
    style: { fontFamily: "inherit", fontSize: "12px", background: "transparent", color: css("--ink-2") },
    x: { label: null, tickFormat: "d", type: "band", padding: 0.18, tickSize: 0, ticks: rows.filter((r) => r.year % 5 === 0).map((r) => r.year) },
    y: { label: `${SERIES_LABEL[key]} hotspots per year`, grid: true, tickFormat: "~s" },
    marks: [
      Plot.barY(rows, {
        x: "year",
        y: "value",
        fill: (d: AnnualRow) => (d.estimated ? css("--bar-est") : css("--bar")),
        title: (d: AnnualRow) => `${d.year}: ${fmtInt.format(d.value)}${d.estimated ? ` (estimated, 90% range ${fmtInt.format(d.lo)}–${fmtInt.format(d.hi)})` : ""}`,
      }),
      Plot.ruleX(rows.filter((r) => r.estimated), { x: "year", y1: "lo", y2: "hi", stroke: css("--ink-2"), strokeWidth: 1.2 }),
      sen && sen.p < 0.05 ? Plot.line(trendLine, { x: "year", y: "value", stroke: css("--action"), strokeWidth: 2, strokeDasharray: "5,3" }) : null,
      Plot.ruleY([0]),
    ],
  });
  host.replaceChildren(chart);
}

export function renderBeforeAfter(host: HTMLElement, meta: Meta): void {
  const a = meta.proof.annual;
  const rows = a.years.flatMap((y, i) => [
    { year: y, value: a.naive[i], series: "Naive splice" },
    { year: y, value: a.harmonized[i], series: "Harmonized (VIIRS-equivalent)" },
    { year: y, value: a.modis_raw[i], series: "MODIS alone" },
  ]);
  const band = a.years.map((y, i) => ({ year: y, lo: a.lo[i], hi: a.hi[i] })).filter((d) => d.year < 2012);
  const color = {
    domain: ["Naive splice", "Harmonized (VIIRS-equivalent)", "MODIS alone"],
    range: [css("--naive"), css("--action"), css("--ink-3")],
  };
  const chart = Plot.plot({
    width: Math.max(320, host.clientWidth),
    height: 300,
    marginLeft: 64,
    style: { fontFamily: "inherit", fontSize: "12px", background: "transparent", color: css("--ink-2") },
    x: { label: null, tickFormat: "d" },
    y: { label: "Hotspots per year, Brazil", grid: true, tickFormat: "~s" },
    color: { ...color, legend: true },
    marks: [
      Plot.areaY(band, { x: "year", y1: "lo", y2: "hi", fill: css("--action"), fillOpacity: 0.15 }),
      Plot.ruleX([2011.5], { stroke: css("--ink-3"), strokeDasharray: "2,3" }),
      Plot.text([{ x: 2011.5 }], { x: "x", frameAnchor: "top", dy: 6, dx: 6, textAnchor: "start", text: () => "VIIRS joins (2012)", fill: css("--ink-2") }),
      Plot.line(rows.filter((d) => d.series !== "Naive splice"), { x: "year", y: "value", stroke: "series", strokeWidth: 2 }),
      Plot.line(rows.filter((d) => d.series === "Naive splice"), { x: "year", y: "value", stroke: "series", strokeWidth: 2.5, strokeDasharray: "6,4" }),
      Plot.dot(rows, { x: "year", y: "value", fill: "series", r: 2.5, tip: true, title: (d) => `${d.series}, ${d.year}: ${fmtInt.format(d.value)}` }),
    ],
  });
  host.replaceChildren(chart);
}

export function renderValidation(host: HTMLElement, v: Validation, names: Map<string, string>): void {
  const width = Math.max(300, host.clientWidth);
  const narrow = width < 640;
  const order = [...new Set(v.points.map((p) => p.region))].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
  const cols = narrow ? 3 : order.length;
  const pts = v.points.map((p) => {
    const k = order.indexOf(p.region);
    return { ...p, obs1: p.obs + 1, pred1: p.pred + 1, col: k % cols, row: Math.floor(k / cols) };
  });
  const labels = order.map((r, k) => ({ name: names.get(r) ?? r, col: k % cols, row: Math.floor(k / cols) }));
  const chart = Plot.plot({
    width,
    height: narrow ? 394 : 294,
    marginLeft: 52,
    marginTop: 22,
    style: { fontFamily: "inherit", fontSize: "11px", background: "transparent", color: css("--ink-2") },
    x: { type: "log", label: "Observed VIIRS (+1)", ticks: 3, tickFormat: "~s" },
    y: { type: "log", label: "Predicted from MODIS (+1)", ticks: 3, tickFormat: "~s" },
    fx: { axis: null, padding: 0.08 },
    fy: { axis: null, padding: 0.12 },
    facet: { data: pts, x: "col", y: "row" },
    marks: [
      Plot.frame({ stroke: css("--rule") }),
      Plot.link([{ a: 1, b: 1e5 }], { x1: "a", y1: "a", x2: "b", y2: "b", stroke: css("--ink-3"), strokeDasharray: "3,3" }),
      Plot.dot(pts, { x: "obs1", y: "pred1", r: 1.8, fill: css("--action"), fillOpacity: 0.55 }),
      Plot.text(labels, { fx: "col", fy: "row", text: "name", frameAnchor: "top-left", dx: 5, dy: 5, fill: css("--ink"), fontWeight: 500 }),
    ],
  });
  host.replaceChildren(chart);
}
