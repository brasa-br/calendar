import * as d3 from "d3";
import { MONTHS, SOURCE_LABEL, isEstimated, valueAt, type Series, type SeriesKey, type ViewKey } from "./data";
import { fmtInt } from "./stats";

export interface CalendarCell {
  year: number;
  month: number; // 0-11
  i: number; // index into series arrays
  value: number | null;
  anomaly: number | null; // log2((v+1)/(mean+1))
  monthMean: number | null;
}

export interface CalendarInput {
  series: Series;
  key: SeriesKey;
  view: ViewKey;
  from: number;
  to: number;
}

export function buildCells({ series, key, from, to }: CalendarInput): CalendarCell[] {
  const pos = new Map(series.months.map((m, i) => [m, i]));
  const cells: CalendarCell[] = [];
  for (let y = from; y <= to; y++) {
    for (let m = 0; m < 12; m++) {
      const i = pos.get(`${y}-${String(m + 1).padStart(2, "0")}`);
      const value = i === undefined ? null : valueAt(series, key, i);
      cells.push({ year: y, month: m, i: i ?? -1, value, anomaly: null, monthMean: null });
    }
  }
  for (let m = 0; m < 12; m++) {
    const vals = cells.filter((c) => c.month === m && c.value !== null).map((c) => c.value as number);
    const mean = vals.length ? d3.mean(vals)! : null;
    for (const c of cells) {
      if (c.month !== m) continue;
      c.monthMean = mean;
      if (c.value !== null && mean !== null) c.anomaly = Math.log2((c.value + 1) / (mean + 1));
    }
  }
  return cells;
}

/** Log colour scale anchored on the selection's own range (2nd percentile of non-zero months to max). */
export function countScale(cells: CalendarCell[]): d3.ScaleSequential<string> {
  const pos = cells.map((c) => c.value ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const max = pos.length ? pos[pos.length - 1] : 2;
  const lo = pos.length ? Math.max(1, d3.quantileSorted(pos, 0.02) ?? 1) : 1;
  return d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([lo, Math.max(lo * 2, max)]).clamp(true);
}

const CELL_H = 22;
const LABEL_W = 44;
const TOP = 26;

/** Renders the years × months heatmap. Keyboard: arrow keys move, Home/End jump within a row. */
export function renderCalendar(host: HTMLElement, tip: HTMLElement, input: CalendarInput, title: string): void {
  const cells = buildCells(input);
  const { series, view, from, to } = input;
  const years = d3.range(from, to + 1);
  const width = Math.max(320, host.clientWidth || 720);
  const cellW = (width - LABEL_W) / 12;
  const height = TOP + years.length * CELL_H + 4;

  const max = d3.max(cells, (c) => c.value ?? 0) || 1;
  const counts = countScale(cells);
  const anomaly = d3.scaleDiverging(d3.interpolatePuOr).domain([2, 0, -2]).clamp(true);
  const fill = (c: CalendarCell) => {
    if (c.value === null) return "var(--cell-nodata)";
    if (view === "anomaly") return c.anomaly === null ? "var(--cell-nodata)" : anomaly(c.anomaly);
    return c.value === 0 ? "var(--cell-zero)" : counts(c.value);
  };

  host.querySelectorAll(":scope > svg, :scope > .skeleton").forEach((n) => n.remove());
  const svg = d3
    .select(host)
    .insert("svg", ".tip")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("role", "grid")
    .attr("aria-label", title);

  const defs = svg.append("defs");
  defs
    .append("pattern")
    .attr("id", "qa-hatch")
    .attr("width", 5)
    .attr("height", 5)
    .attr("patternUnits", "userSpaceOnUse")
    .attr("patternTransform", "rotate(45)")
    .append("line")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", 0)
    .attr("y2", 5)
    .attr("stroke", "var(--ink)")
    .attr("stroke-opacity", 0.45)
    .attr("stroke-width", 1.4);

  svg
    .append("g")
    .attr("aria-hidden", "true")
    .selectAll("text")
    .data(MONTHS)
    .join("text")
    .attr("class", "cal-axis")
    .attr("x", (_, m) => LABEL_W + m * cellW + cellW / 2)
    .attr("y", TOP - 9)
    .attr("text-anchor", "middle")
    .text((d) => (cellW < 34 ? d[0] : d));

  const rows = svg
    .append("g")
    .selectAll("g")
    .data(years)
    .join("g")
    .attr("role", "row")
    .attr("transform", (_, k) => `translate(0, ${TOP + k * CELL_H})`);

  rows
    .append("text")
    .attr("class", "cal-axis")
    .attr("role", "rowheader")
    .attr("x", LABEL_W - 8)
    .attr("y", CELL_H / 2 + 4)
    .attr("text-anchor", "end")
    .text((y) => y);

  const byYear = d3.group(cells, (c) => c.year);
  const nodes: SVGGElement[] = [];
  rows.each(function (y) {
    const g = d3
      .select(this)
      .selectAll<SVGGElement, CalendarCell>("g.cell")
      .data(byYear.get(y) ?? [])
      .join("g")
      .attr("class", "cell")
      .attr("role", "gridcell")
      .attr("tabindex", -1)
      .attr("transform", (c) => `translate(${LABEL_W + c.month * cellW}, 0)`)
      .attr("aria-label", (c) => ariaLabel(c, series, input.key))
      .each(function () {
        nodes.push(this);
      });
    g.append("rect")
      .attr("x", 1)
      .attr("y", 1)
      .attr("width", cellW - 2)
      .attr("height", CELL_H - 2)
      .attr("rx", 2)
      .attr("fill", fill);
    g.filter((c) => c.i >= 0 && series.qa_flag[c.i] === 1)
      .append("rect")
      .attr("x", 1)
      .attr("y", 1)
      .attr("width", cellW - 2)
      .attr("height", CELL_H - 2)
      .attr("fill", "url(#qa-hatch)");
    g.filter((c) => input.key === "harmonized" && c.i >= 0 && isEstimated(series.source[c.i]))
      .append("circle")
      .attr("class", "est-dot")
      .attr("cx", cellW - 6)
      .attr("cy", 6)
      .attr("r", 2.2);
  });

  // The 2012 seam: where the satellite record changes.
  if (from < 2012 && to >= 2012) {
    const y = TOP + (2012 - from) * CELL_H;
    const seam = svg.append("g").attr("class", "seam").attr("aria-hidden", "true");
    seam.append("line").attr("x1", 0).attr("x2", width).attr("y1", y).attr("y2", y);
  }

  // Roving tabindex + tooltip
  const cols = 12;
  let active = Math.max(0, cells.findIndex((c) => c.value !== null && c.value === max));
  const focusCell = (k: number, move = true) => {
    nodes.forEach((n, j) => n.setAttribute("tabindex", j === k ? "0" : "-1"));
    active = k;
    if (move) nodes[k].focus();
  };
  focusCell(active, false);

  const show = (c: CalendarCell, el: Element) => {
    tip.innerHTML = tooltipHTML(c, series, input.key, view);
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const left = Math.min(r.left - hr.left + r.width / 2, hr.width - 150);
    tip.style.left = `${Math.max(150, left)}px`;
    tip.style.top = `${r.top - hr.top}px`;
  };
  const hide = () => (tip.hidden = true);

  svg
    .selectAll<SVGGElement, CalendarCell>("g.cell")
    .on("mouseenter", function (_, c) {
      show(c, this);
    })
    .on("mouseleave", hide)
    .on("focus", function (_, c) {
      show(c, this);
    })
    .on("blur", hide)
    .on("keydown", (ev: KeyboardEvent) => {
      const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
      let k = active;
      if (ev.key in map) k = active + map[ev.key];
      else if (ev.key === "Home") k = active - (active % cols);
      else if (ev.key === "End") k = active - (active % cols) + cols - 1;
      else if (ev.key === "Escape") return hide();
      else return;
      ev.preventDefault();
      if (k >= 0 && k < nodes.length) focusCell(k);
    });
}

function ariaLabel(c: CalendarCell, s: Series, key: SeriesKey): string {
  const when = `${MONTHS[c.month]} ${c.year}`;
  if (c.value === null) return `${when}: no data for this sensor`;
  const est = key === "harmonized" && c.i >= 0 && isEstimated(s.source[c.i]) ? ", estimated" : "";
  return `${when}: ${fmtInt.format(c.value)} hotspots${est}`;
}

function tooltipHTML(c: CalendarCell, s: Series, key: SeriesKey, view: ViewKey): string {
  const when = `${MONTHS[c.month]} ${c.year}`;
  if (c.value === null || c.i < 0) return `<strong>${when}</strong><div>No data for this sensor</div>`;
  const i = c.i;
  const rows: string[] = [];
  const est = key === "harmonized" && isEstimated(s.source[i]);
  rows.push(`<div class="tip-value">${fmtInt.format(c.value)} <span>hotspots</span></div>`);
  if (est) rows.push(`<div>90% interval: ${fmtInt.format(s.lo[i])}–${fmtInt.format(s.hi[i])}</div>`);
  if (view === "anomaly" && c.monthMean !== null) {
    const pct = ((c.value + 1) / (c.monthMean + 1) - 1) * 100;
    rows.push(`<div>${pct >= 0 ? "+" : ""}${Math.round(pct)}% vs. average ${MONTHS[c.month]}</div>`);
  }
  if (key === "harmonized") rows.push(`<div class="tip-muted">${SOURCE_LABEL[s.source[i]] ?? s.source[i]}</div>`);
  const v = s.viirs_raw[i];
  rows.push(
    `<dl class="tip-dl"><dt>MODIS</dt><dd>${fmtInt.format(s.modis_raw[i])}</dd><dt>VIIRS</dt><dd>${
      v === null ? "not in orbit" : fmtInt.format(v)
    }</dd></dl>`,
  );
  if (s.qa_flag[i]) rows.push(`<div class="tip-warn">Reduced satellite coverage this month</div>`);
  return `<strong>${when}</strong>${rows.join("")}`;
}

/** Colour legend matching the calendar scale. */
export function renderLegend(host: HTMLElement, view: ViewKey, cells: CalendarCell[]): void {
  host.replaceChildren();
  const w = 220;
  const svg = d3.select(host).append("svg").attr("width", w + 20).attr("height", 34).attr("aria-hidden", "true");
  const id = `grad-${view}`;
  const grad = svg.append("defs").append("linearGradient").attr("id", id);
  const stops = d3.range(0, 1.0001, 0.1);
  const sc = countScale(cells);
  const [lo, hi] = sc.domain();
  const at = (t: number) => lo * Math.pow(hi / lo, t);
  if (view === "counts") {
    stops.forEach((t) => grad.append("stop").attr("offset", t).attr("stop-color", sc(at(t))));
  } else {
    stops.forEach((t) => grad.append("stop").attr("offset", t).attr("stop-color", d3.interpolatePuOr(1 - t)));
  }
  svg.append("rect").attr("x", 10).attr("y", 4).attr("width", w).attr("height", 10).attr("rx", 2).attr("fill", `url(#${id})`);
  const labels =
    view === "counts"
      ? [[`${fmtInt.format(lo)} or less`, 0], [fmtInt.format(Math.round(at(0.5))), 0.5], [fmtInt.format(hi), 1]]
      : [["¼ of usual", 0], ["usual", 0.5], ["4× usual", 1]];
  svg
    .selectAll("text")
    .data(labels)
    .join("text")
    .attr("class", "cal-axis")
    .attr("x", (d) => 10 + (d[1] as number) * w)
    .attr("y", 28)
    .attr("text-anchor", (d) => (d[1] === 0 ? "start" : d[1] === 1 ? "end" : "middle"))
    .text((d) => d[0] as string);
}
