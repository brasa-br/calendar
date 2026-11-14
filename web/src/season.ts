import * as Plot from "@observablehq/plot";
import { MONTHS, valueAt, type Series, type SeriesKey } from "./data";
import { fmt1, fmtInt } from "./stats";

/** Cumulative hotspots of one year compared with every earlier year in the selection. */
export interface SeasonResult {
  focus: number;
  last: number; // last month index (0–11) with data in the focus year
  years: number[]; // comparison years (complete, before focus)
  cum: Map<number, number[]>; // year -> 12 cumulative values
  focusCum: number[]; // up to `last`
  median: number[]; // 12 values
  rank: number; // 1 = most hotspots by `last` among comparison years + focus
  aheadSince: number | null; // first month from which the focus year stays above every earlier year
  monthRecords: { m: number; value: number; prevMax: number; prevYear: number }[];
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};

function monthly(s: Series, key: SeriesKey, year: number): (number | null)[] {
  const out: (number | null)[] = Array(12).fill(null);
  s.months.forEach((ym, i) => {
    if (+ym.slice(0, 4) === year) out[+ym.slice(5, 7) - 1] = valueAt(s, key, i);
  });
  return out;
}

const cumulate = (v: number[]) => v.reduce<number[]>((acc, x, i) => (acc.push((acc[i - 1] ?? 0) + x), acc), []);

export function seasonCompare(s: Series, key: SeriesKey, from: number, focus: number): SeasonResult | null {
  const fm = monthly(s, key, focus);
  let last = -1;
  for (let m = 0; m < 12 && fm[m] !== null; m++) last = m;
  if (last < 0) return null;
  const years: number[] = [];
  const raw = new Map<number, number[]>();
  for (let y = from; y < focus; y++) {
    const v = monthly(s, key, y);
    if (v.every((x) => x !== null)) {
      years.push(y);
      raw.set(y, v as number[]);
    }
  }
  const cum = new Map([...raw].map(([y, v]) => [y, cumulate(v)] as const));
  const focusCum = cumulate(fm.slice(0, last + 1) as number[]);
  const med = MONTHS.map((_, m) => (years.length ? median(years.map((y) => cum.get(y)![m])) : 0));
  const prevMax = (m: number) => Math.max(...years.map((y) => cum.get(y)![m]));
  let aheadSince: number | null = null;
  if (years.length) {
    for (let m = last; m >= 0 && focusCum[m] > prevMax(m) && focusCum[m] > 0; m--) aheadSince = m;
  }
  const monthRecords = [];
  if (years.length) {
    for (let m = 0; m <= last; m++) {
      let best = -1, bestYear = years[0];
      for (const y of years) if (raw.get(y)![m] > best) [best, bestYear] = [raw.get(y)![m], y];
      const v = fm[m] as number;
      if (v > best && v > 0) monthRecords.push({ m, value: v, prevMax: best, prevYear: bestYear });
    }
  }
  const rank = 1 + years.filter((y) => cum.get(y)![last] > focusCum[last]).length;
  return { focus, last, years, cum, focusCum, median: med, rank, aheadSince, monthRecords };
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** One-paragraph verdict, written for someone planning the fire season. */
export function seasonVerdict(r: SeasonResult, name: string, partial: boolean): string {
  const n = r.years.length;
  const span = `${r.years[0]} to ${r.years[n - 1]}`;
  const at = `the end of ${MONTHS_LONG[r.last]} ${r.focus}`;
  const total = fmtInt.format(r.focusCum[r.last]);
  const med = r.median[r.last];
  const ratio = med > 0 ? r.focusCum[r.last] / med : null;
  const vsMedian =
    ratio === null ? "" : ratio >= 1.05 ? `, ${fmt1.format(ratio)}× the median year` : ratio > 0.95 ? ", close to the median year" : `, ${Math.round(100 * (1 - ratio))}% below the median year`;
  if (r.aheadSince !== null) {
    const since = `${MONTHS_LONG[r.aheadSince]} ${r.focus}`;
    return partial
      ? `Since ${since}, ${name} has been ahead of every year from ${span} at the same point. By ${at} it had ${total} hotspots${vsMedian}.`
      : `From ${since} until December, ${name} stayed ahead of every year from ${span} at the same point. It closed ${r.focus} with ${total} hotspots${vsMedian}.`;
  }
  const more = r.rank - 1;
  const place =
    more === 0 ? `more than any year from ${span} at the same point`
    : more === n ? `fewer than any year from ${span} at the same point`
    : `${more} of the ${n} years from ${span} had more by then`;
  return `By ${at}, ${name} had ${total} hotspots${vsMedian}: ${place}.`;
}

export function renderSeason(host: HTMLElement, r: SeasonResult, width: number): void {
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const others = r.years.flatMap((y) => r.cum.get(y)!.map((v, m) => ({ y, m, v })));
  const med = r.median.map((v, m) => ({ m, v }));
  const focus = r.focusCum.map((v, m) => ({ m, v }));
  const narrow = width < 560;
  const chart = Plot.plot({
    width,
    height: narrow ? 260 : 300,
    marginLeft: 52,
    marginRight: narrow ? 44 : 64,
    style: { fontFamily: "inherit", fontSize: "12px", background: "transparent", color: css("--ink-2") },
    x: { domain: [0, 11], ticks: narrow ? [0, 3, 6, 9, 11] : MONTHS.map((_, i) => i), tickFormat: (i: number) => MONTHS[i], label: null },
    y: { label: "Hotspots since January", grid: true, tickFormat: "~s", nice: true },
    marks: [
      Plot.line(others, { x: "m", y: "v", z: "y", stroke: css("--ink-3"), strokeOpacity: 0.28, strokeWidth: 1 }),
      Plot.line(med, { x: "m", y: "v", stroke: css("--ink-2"), strokeDasharray: "4,3", strokeWidth: 1.5 }),
      Plot.line(focus, { x: "m", y: "v", stroke: css("--bar"), strokeWidth: 3, className: "season-focus" }),
      Plot.dot(focus.slice(-1), { x: "m", y: "v", fill: css("--bar"), r: 4.5, className: "season-focus-end" }),
      Plot.text(focus.slice(-1), { x: "m", y: "v", text: () => String(r.focus), dx: 8, textAnchor: "start", fill: css("--ink"), fontWeight: 650, fontSize: 13, className: "season-focus-end" }),
      Plot.tip([...others, ...focus.map((d) => ({ ...d, y: r.focus }))], Plot.pointer({
        x: "m", y: "v", stroke: css("--rule"),
        title: (d: { y: number; m: number; v: number }) => `${d.y}, end of ${MONTHS_LONG[d.m]}: ${fmtInt.format(d.v)} hotspots`,
      })),
    ],
  });
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `Cumulative hotspots through the year. ${r.focus} reached ${fmtInt.format(r.focusCum[r.last])} by the end of ${MONTHS[r.last]}; the median of ${r.years.length} earlier years was ${fmtInt.format(r.median[r.last])} at that point.`,
  );
  host.replaceChildren(chart);
}
