import { MONTHS, type Warning } from "./data";
import { fmt1, fmtInt } from "./stats";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};
const pct = (p: number | null) => (p === null ? "—" : p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const listYears = (ys: number[]) =>
  ys.length < 2 ? String(ys[0] ?? "") : `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;

/** "Does this warning work?": the signal replayed on every region and year, with false alarms. */
export function renderWarningCheck(host: HTMLElement, w: Warning): void {
  const b = w.backtest;
  const lead = el("p");
  lead.textContent =
    `This comparison was replayed on all ${b.regions} regions, for every year from ${b.years[0]} to ${b.years[1]} ` +
    `(${fmtInt.format(b.region_years)} region-years), each time using only the years before it. ` +
    `A year counts as severe when it ends with at least ${b.severe_x}× the median of the years before it; ${b.severe} did. ` +
    `${b.ahead_before_peak} of those ${b.severe} were ahead of every earlier year before their peak month` +
    (b.median_lead_months !== null ? `, a median of ${fmtInt.format(b.median_lead_months)} months before it.` : ".");

  const table = el("table", undefined, "metrics warning-table");
  const cap = el("caption", `How the signal "ahead of every earlier year" performed, ${b.years[0]}–${b.years[1]}`, "visually-hidden");
  const head = el("thead");
  const hr = el("tr");
  for (const [t, unit] of [
    ["Ahead by the end of", ""],
    ["Severe years caught", `of ${b.severe}`],
    ["False alarms", "flagged, not severe"],
    ["Flagged year turned severe", ""],
    ["Unflagged year turned severe", ""],
  ]) {
    const th = el("th", t);
    th.scope = "col";
    if (unit) th.append(el("span", unit, "unit"));
    hr.append(th);
  }
  head.append(hr);
  const body = el("tbody");
  for (const r of b.by_month) {
    const tr = el("tr");
    const th = el("th", MONTH_NAMES[r.month - 1]);
    th.scope = "row";
    tr.append(th, el("td", String(r.hits)), el("td", String(r.false_alarms)), el("td", pct(r.p_severe_if_flagged)), el("td", pct(r.p_severe_if_not)));
    body.append(tr);
  }
  table.append(cap, head, body);
  const scroll = el("div", undefined, "table-scroll");
  scroll.append(table);

  const late = b.events.filter((e) => !e.first_ahead || e.first_ahead >= e.peak_month);
  const jul = b.by_month.find((r) => r.month === 7);
  const notes = el("p", undefined, "small");
  const parts: string[] = [];
  if (jul?.false_alarm_median_ratio)
    parts.push(
      `False alarms are not quiet years: flagged by the end of July but under the severe line, they still ended a median ${fmt1.format(jul.false_alarm_median_ratio)}× their usual year.`,
    );
  if (late.length) {
    const byRegion = new Map<string, number[]>();
    for (const e of late) byRegion.set(e.name, [...(byRegion.get(e.name) ?? []), e.year].sort());
    const list = [...byRegion].map(([n, ys]) => `${n} in ${listYears(ys)}`).join("; ");
    const early = late.every((e) => e.peak_month <= 3);
    parts.push(`Not caught before the peak: ${list}${early ? ", where the season peaks between January and March, before any warning can run ahead for long" : ""}.`);
  }
  notes.textContent = parts.join(" ");
  host.replaceChildren(lead, scroll, notes);
}

/** "Where <year> stands": every region's running total against its own earlier years. */
export function renderStands(host: HTMLElement, title: HTMLElement, w: Warning, onPick: (region: string) => void): void {
  const c = w.current;
  if (!c) {
    host.closest("section")?.setAttribute("hidden", "");
    return;
  }
  const through = MONTHS[c.through_month - 1];
  title.textContent = `Where ${c.year} stands`;
  const ahead = c.regions.filter((r) => r.ahead);
  const above = c.regions.filter((r) => (r.vs_median ?? 0) > 1).length;
  const verdict = el("p", undefined, "verdict");
  verdict.textContent = ahead.length
    ? `${ahead.length} of ${c.regions.length} regions are ahead of every earlier year through ${through} ${c.year}. ${above} are above their median year.`
    : `No region is ahead of every earlier year through ${through} ${c.year}. ${above} of ${c.regions.length} are above their median year for this point of the year.`;

  const shown = [...ahead, ...c.regions.filter((r) => !r.ahead)].slice(0, Math.max(6, ahead.length));
  const list = el("ul", undefined, "records stands");
  for (const r of shown) {
    const li = el("li");
    const btn = el("button", r.name, "linklike");
    btn.type = "button";
    btn.addEventListener("click", () => onPick(r.region));
    const strong = el("strong");
    strong.append(btn);
    const detail =
      `${r.vs_median === null ? "" : `${fmt1.format(r.vs_median)}× the median, `}${ordinal(r.rank)} highest of ${r.of} years` +
      (r.ahead && r.since ? `; ahead of every earlier year since ${MONTHS[r.since - 1]}` : "");
    li.append(strong, el("span", `${fmtInt.format(r.total)} hotspots. ${detail[0].toUpperCase()}${detail.slice(1)}.`));
    list.append(li);
  }
  host.replaceChildren(verdict, list);
}
