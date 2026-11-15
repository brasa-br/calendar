import * as Plot from "@observablehq/plot";
import { annualRows } from "./charts";
import { MONTHS, valueAt, type Series, type SeriesKey } from "./data";
import { fmt1, fmtInt, fmtSigned, fmtP, mannKendall } from "./stats";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};

export interface CompareSide { id: string; name: string; series: Series }

interface Profile {
  name: string;
  years: { year: number; value: number; index: number }[];
  share: number[]; // share of the yearly hotspots in each month, 0–1
  medianYear: number;
  worst: { year: number; value: number } | null;
  peak: number;
  trend: string;
}

function profile(side: CompareSide, key: SeriesKey, from: number, to: number): Profile {
  const rows = annualRows(side.series, key, from, to);
  const med = rows.length ? median(rows.map((r) => r.value)) : 0;
  const byMonth = new Array(12).fill(0);
  const done = new Set(rows.map((r) => r.year));
  side.series.months.forEach((m, i) => {
    if (!done.has(+m.slice(0, 4))) return;
    byMonth[+m.slice(5, 7) - 1] += valueAt(side.series, key, i) ?? 0;
  });
  const total = byMonth.reduce((a, b) => a + b, 0);
  const share = byMonth.map((v) => (total > 0 ? v / total : 0));
  const worst = rows.reduce<{ year: number; value: number } | null>((w, r) => (!w || r.value > w.value ? { year: r.year, value: r.value } : w), null);
  let trend = "Needs at least four years";
  if (rows.length >= 4) {
    const mk = mannKendall(rows.map((r) => r.value));
    trend = mk.p < 0.05 ? `${fmtSigned(mk.slope)} per year (${fmtP(mk.p)})` : `No significant trend (${fmtP(mk.p)})`;
  }
  return {
    name: side.name,
    years: rows.map((r) => ({ year: r.year, value: r.value, index: med > 0 ? r.value / med : 0 })),
    share,
    medianYear: med,
    worst,
    peak: share.indexOf(Math.max(...share)),
    trend,
  };
}

/** Two regions side by side: a fact table, each year against the region's usual year, and the season's shape. */
export function renderCompare(
  hosts: { facts: HTMLElement; annual: HTMLElement; season: HTMLElement; note: HTMLElement },
  a: CompareSide,
  b: CompareSide,
  key: SeriesKey,
  from: number,
  to: number,
): void {
  const pa = profile(a, key, from, to);
  const pb = profile(b, key, from, to);
  const same = a.id === b.id;
  const colors = { domain: [pa.name, same ? `${pb.name} ` : pb.name], range: [css("--action"), css("--bar")] };
  const label = (p: Profile, i: number) => (i === 1 && same ? `${p.name} ` : p.name);

  // Facts
  const table = document.createElement("table");
  table.className = "metrics compare-table";
  const head = table.createTHead().insertRow();
  for (const t of ["", pa.name, pb.name]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = t;
    head.append(th);
  }
  const body = table.createTBody();
  const facts: [string, (p: Profile) => string][] = [
    ["Median year", (p) => (p.years.length ? fmtInt.format(p.medianYear) : "—")],
    ["Worst year", (p) => (p.worst ? `${p.worst.year} (${fmtInt.format(p.worst.value)})` : "—")],
    ["Peak month", (p) => (p.years.length ? `${MONTHS[p.peak]} (${Math.round(p.share[p.peak] * 100)}% of the year)` : "—")],
    ["Trend", (p) => p.trend],
  ];
  for (const [t, f] of facts) {
    const tr = body.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = t;
    tr.append(th);
    for (const p of [pa, pb]) tr.insertCell().textContent = f(p);
  }
  hosts.facts.replaceChildren(table);

  const width = Math.max(300, hosts.annual.clientWidth);
  const style = { fontFamily: "inherit", fontSize: "12px", background: "transparent", color: css("--ink-2") };
  const dash = (i: number) => (i === 0 ? "none" : "6,4");

  // Each year against the region's own median year, so a small region and a large one share one axis.
  const annual = [pa, pb].flatMap((p, i) => p.years.map((y) => ({ ...y, region: label(p, i), i })));
  const annualChart = Plot.plot({
    width,
    height: 260,
    marginLeft: 48,
    style,
    x: {
      label: null,
      tickFormat: "d",
      // Phones get a tick every five years; wider screens let Plot choose.
      ticks: width < 600 ? [...new Set(annual.map((d) => d.year))].filter((y) => y % 5 === 0) : Math.min(8, annual.length / 2 || 1),
    },
    y: { label: "× the region's median year", grid: true, zero: true, tickFormat: (d: number) => `${fmt1.format(d)}×` },
    color: { ...colors, legend: true },
    marks: [
      Plot.ruleY([1], { stroke: css("--ink-3"), strokeDasharray: "2,3" }),
      ...[0, 1].map((i) =>
        Plot.line(annual.filter((d) => d.i === i), { x: "year", y: "index", stroke: "region", strokeWidth: 2, strokeDasharray: dash(i) }),
      ),
      Plot.dot(annual, {
        x: "year",
        y: "index",
        fill: "region",
        r: 3,
        title: (d: (typeof annual)[number]) => `${d.region}, ${d.year}: ${fmtInt.format(d.value)} hotspots, ${fmt1.format(d.index)}× its median year`,
      }),
    ],
  });
  hosts.annual.replaceChildren(annualChart);

  const season = [pa, pb].flatMap((p, i) => p.share.map((s, m) => ({ m, s, region: label(p, i), i })));
  const narrow = width < 480;
  const seasonChart = Plot.plot({
    width,
    height: 260,
    marginLeft: 48,
    style,
    x: { domain: [0, 11], ticks: narrow ? [0, 3, 6, 9, 11] : MONTHS.map((_, i) => i), tickFormat: (i: number) => MONTHS[i], label: null },
    y: { label: "Share of the year's hotspots", grid: true, tickFormat: (d: number) => `${Math.round(d * 100)}%` },
    color: { ...colors, legend: true },
    marks: [
      ...[0, 1].map((i) =>
        Plot.line(season.filter((d) => d.i === i), { x: "m", y: "s", stroke: "region", strokeWidth: 2, strokeDasharray: dash(i), curve: "monotone-x" }),
      ),
      Plot.dot(season, {
        x: "m",
        y: "s",
        fill: "region",
        r: 3,
        title: (d: (typeof season)[number]) => `${d.region}, ${MONTHS[d.m]}: ${Math.round(d.s * 100)}% of the year's hotspots`,
      }),
      Plot.ruleY([0]),
    ],
  });
  hosts.season.replaceChildren(seasonChart);

  const ys = [...pa.years, ...pb.years].map((y) => y.year);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = !ys.length ? "" : lo === hi ? `${lo}` : `${lo}–${hi}`;
  hosts.note.textContent = same
    ? "Both sides show the same region. Choose a different second region."
    : ys.length
      ? `${lo === hi ? "Complete year" : "Complete years"}: ${span}. A year still in progress is left out. A value of 2× means twice the hotspots of that region's median year.`
      : key === "viirs" && to < 2012
        ? "VIIRS has no data before 2012. Choose Harmonized or a later period above."
        : "No complete year in this period yet. Choose a longer period above.";
}
