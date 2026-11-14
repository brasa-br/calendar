import "./styles.css";
import {
  FIRST_YEAR, LAST_MONTH, LAST_YEAR, MONTHS, SERIES_LABEL, setSpan,
  loadBoundaries, loadMeta, loadRegions, loadSeries, loadValidation,
  valueAt, type Meta, type Region, type Series, type SeriesKey, type Validation, type ViewKey,
} from "./data";
import { buildCells, renderCalendar, renderLegend } from "./calendar";
import { annualRows, renderAnnual, renderBeforeAfter, renderValidation } from "./charts";
import { renderMap, setTopology, type MapLayer } from "./map";
import { fmt1, fmt2, fmtInt, fmtP, fmtSigned, mannKendall } from "./stats";
import { renderSeason, seasonCompare, seasonVerdict } from "./season";
import { initHero } from "./hero";

interface State { r: string; from: number; to: number; s: SeriesKey; v: ViewKey; layer: MapLayer }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SERIES: SeriesKey[] = ["harmonized", "naive", "modis", "viirs"];

function readState(): State {
  const q = new URLSearchParams(location.search);
  const year = (k: string, d: number) => {
    const n = Number(q.get(k));
    return Number.isInteger(n) && n >= FIRST_YEAR && n <= LAST_YEAR ? n : d;
  };
  let from = year("from", FIRST_YEAR);
  let to = year("to", LAST_YEAR);
  if (from > to) [from, to] = [to, from];
  const s = q.get("s") as SeriesKey;
  return {
    r: q.get("r") ?? "BR",
    from,
    to,
    s: SERIES.includes(s) ? s : "harmonized",
    v: q.get("v") === "anomaly" ? "anomaly" : "counts",
    layer: q.get("map") === "biomes" ? "biomes" : "states",
  };
}

function writeState(st: State): void {
  const q = new URLSearchParams();
  if (st.r !== "BR") q.set("r", st.r);
  if (st.from !== FIRST_YEAR) q.set("from", String(st.from));
  if (st.to !== LAST_YEAR) q.set("to", String(st.to));
  if (st.s !== "harmonized") q.set("s", st.s);
  if (st.v !== "counts") q.set("v", st.v);
  if (st.layer !== "states") q.set("map", st.layer);
  const qs = q.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

let state = readState();
let regions: Region[] = [];
let names = new Map<string, string>();
let meta: Meta | null = null;
let current: Series | null = null;
let validation: Validation | null = null;
let requestId = 0;
const allSeries = new Map<string, Series>();

function showError(msg: string): void {
  const el = $("error");
  el.textContent = msg;
  el.hidden = false;
}

function fillControls(): void {
  const sel = $<HTMLSelectElement>("region");
  const groups: [string, Region["kind"]][] = [["Country", "country"], ["Biomes", "biome"], ["States", "state"], ["Local spotlight", "metro"]];
  for (const [label, kind] of groups) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const r of regions.filter((x) => x.kind === kind)) og.append(new Option(r.name, r.id));
    sel.append(og);
  }
  for (const id of ["from", "to"]) {
    const s = $<HTMLSelectElement>(id);
    for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) s.append(new Option(String(y), String(y)));
  }
  syncControls();

  sel.addEventListener("change", () => update({ r: sel.value }));
  $<HTMLSelectElement>("from").addEventListener("change", (e) => {
    const v = +(e.target as HTMLSelectElement).value;
    update({ from: v, to: Math.max(v, state.to) });
  });
  $<HTMLSelectElement>("to").addEventListener("change", (e) => {
    const v = +(e.target as HTMLSelectElement).value;
    update({ to: v, from: Math.min(v, state.from) });
  });
  $("series").addEventListener("change", (e) => update({ s: (e.target as HTMLInputElement).value as SeriesKey }));
  $("view").addEventListener("change", (e) => update({ v: (e.target as HTMLInputElement).value as ViewKey }));
  $("layer").addEventListener("change", (e) => update({ layer: (e.target as HTMLInputElement).value as MapLayer }));
  $("controls").addEventListener("submit", (e) => e.preventDefault());
  $("download").addEventListener("click", downloadCSV);
  $("example-pantanal").addEventListener("click", () => {
    update({ r: "BIOME_PAN", from: FIRST_YEAR, to: 2020, s: "harmonized" });
    $("season").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

function syncControls(): void {
  $<HTMLSelectElement>("region").value = state.r;
  $<HTMLSelectElement>("from").value = String(state.from);
  $<HTMLSelectElement>("to").value = String(state.to);
  for (const [group, val] of [["s", state.s], ["v", state.v], ["layer", state.layer]] as const) {
    const input = document.querySelector<HTMLInputElement>(`input[name="${group}"][value="${val}"]`);
    if (input) input.checked = true;
  }
}

async function update(patch: Partial<State>): Promise<void> {
  state = { ...state, ...patch };
  if (!names.has(state.r)) state.r = "BR";
  syncControls();
  writeState(state);
  const id = ++requestId;
  try {
    const s = await loadSeries(state.r);
    if (id !== requestId) return; // a newer selection superseded this one
    current = s;
    allSeries.set(state.r, current);
    $("error").hidden = true;
    render();
  } catch (err) {
    showError(`The data for this region could not be loaded. Check your connection and choose the region again. (${(err as Error).message})`);
  }
}

function render(): void {
  if (!current) return;
  const name = names.get(state.r) ?? state.r;
  const span = state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`;
  $("cal-title").textContent = `Monthly hotspots in ${name}, ${span}`;
  $("series-note").textContent = seriesNote();

  const input = { series: current, key: state.s, view: state.v, from: state.from, to: state.to };
  renderCalendar($("calendar-host"), $("tip"), input, `Calendar of monthly fire hotspots in ${name}, ${span}`);
  const cells = buildCells(input);
  renderLegend($("legend"), state.v, cells);
  renderSummary(cells);
  renderTable(cells);
  const kind = regions.find((x) => x.id === state.r)?.kind;
  renderSeasonNow(kind === "biome" || kind === "metro" ? `the ${name}` : name);

  const rows = annualRows(current, state.s, state.from, state.to);
  const mk = rows.length >= 4 ? mannKendall(rows.map((r) => r.value)) : null;
  renderAnnual($("annual-host"), rows, state.s, mk ? { slope: mk.slope, p: mk.p } : null);
  $("annual-note").textContent = mk
    ? mk.p < 0.05
      ? `Dashed line: Sen's slope, ${fmtSigned(mk.slope)} hotspots per year (Mann-Kendall ${fmtP(mk.p)}). Lighter bars are years estimated from MODIS; whiskers show the 90% range.`
      : `No statistically significant trend in this period (Mann-Kendall ${fmtP(mk.p)}). Lighter bars are years estimated from MODIS; whiskers show the 90% range.`
    : "Choose at least four years to test for a trend.";
  if (state.to === LAST_YEAR && LAST_MONTH.slice(5) !== "12")
    $("annual-note").textContent += ` ${LAST_YEAR} is left out until the year is complete; see how it compares so far above.`;
  renderMapNow();
}

function renderSeasonNow(name: string): void {
  const verdict = $("season-verdict");
  const host = $("season-host");
  const r = seasonCompare(current!, state.s, state.from, state.to);
  $("season-title").textContent = `How ${state.to} compares with earlier years`;
  $("season-focus-label").textContent = String(state.to);
  const wrap = $("season-records-wrap");
  if (!r || r.years.length < 5) {
    verdict.textContent = r
      ? `Choose a period with at least five complete years before ${state.to} to compare against.`
      : state.s === "viirs" && state.to < 2012
        ? `VIIRS has no data for ${state.to}: it started observing in 2012. Choose Harmonized to compare earlier years.`
        : `No ${SERIES_LABEL[state.s].toLowerCase()} data for ${state.to}.`;
    host.replaceChildren();
    wrap.hidden = true;
    return;
  }
  const partial = r.last < 11;
  verdict.textContent = seasonVerdict(r, name, partial) + (partial ? " Provisional: recent months use near-real-time data." : "");
  renderSeason(host, r, host.clientWidth || 720);
  wrap.hidden = !r.monthRecords.length;
  $("season-records").innerHTML = r.monthRecords
    .map((x) => `<li><strong>${MONTHS[x.m]} ${r.focus}</strong> ${fmtInt.format(x.value)} hotspots <span>Previous highest ${MONTHS[x.m]}: ${fmtInt.format(x.prevMax)} in ${x.prevYear}</span></li>`)
    .join("");
}

function seriesNote(): string {
  switch (state.s) {
    case "harmonized":
      return "VIIRS-equivalent counts: observed by VIIRS from 2012, estimated from calibrated MODIS before that.";
    case "naive":
      return "MODIS until 2011, VIIRS from 2012, joined without calibration. Note the jump at the 2012 line: that is the sensor changing, not the fires.";
    case "modis":
      return "MODIS only (Terra and Aqua, 1 km). Consistent sensor, but it misses small fires that VIIRS detects.";
    case "viirs":
      return "VIIRS only (375 m). Available from 2012.";
  }
}

function renderSummary(cells: ReturnType<typeof buildCells>): void {
  const valid = cells.filter((c) => c.value !== null);
  if (!valid.length) {
    for (const id of ["sum-peak", "sum-season", "sum-total", "sum-trend"]) $(id).textContent = "No data for this sensor in the selected years";
    return;
  }
  const peak = valid.reduce((a, b) => ((b.value as number) > (a.value as number) ? b : a));
  $("sum-peak").innerHTML = `${MONTHS[peak.month]} ${peak.year} <span>${fmtInt.format(peak.value as number)} hotspots</span>`;

  const clim = MONTHS.map((_, m) => {
    const v = valid.filter((c) => c.month === m).map((c) => c.value as number);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  });
  const total = clim.reduce((a, b) => a + b, 0);
  const order = clim.map((v, m) => [v, m] as const).sort((a, b) => b[0] - a[0]);
  const season = new Set<number>();
  let acc = 0;
  for (const [v, m] of order) {
    if (acc >= 0.7 * total) break;
    season.add(m);
    acc += v;
  }
  $("sum-season").innerHTML = total
    ? `${seasonLabel(season)} <span>${Math.round((100 * acc) / total)}% of a typical year's hotspots</span>`
    : "No fires detected";

  const sum = valid.reduce((a, c) => a + (c.value as number), 0);
  $("sum-total").innerHTML = `${fmtInt.format(sum)} <span>hotspots, ${SERIES_LABEL[state.s].toLowerCase()}</span>`;

  const rows = annualRows(current!, state.s, state.from, state.to);
  if (rows.length < 4) {
    $("sum-trend").textContent = "Needs at least four years";
    return;
  }
  const mk = mannKendall(rows.map((r) => r.value));
  const mean = rows.reduce((a, r) => a + r.value, 0) / rows.length;
  const pct = mean ? (100 * mk.slope) / mean : 0;
  $("sum-trend").innerHTML =
    mk.p < 0.05
      ? `${pct >= 0 ? "Rising" : "Falling"} ${fmt1.format(Math.abs(pct))}% per year <span>Mann-Kendall ${fmtP(mk.p)}</span>`
      : `No significant trend <span>Mann-Kendall ${fmtP(mk.p)}</span>`;
}

/** Contiguous (wrapping) month sets read as a range, e.g. "Jul to Oct". */
function seasonLabel(set: Set<number>): string {
  const ms = [...set].sort((a, b) => a - b);
  if (ms.length === 12) return "All year";
  for (let start = 0; start < 12; start++) {
    if (!set.has(start) || set.has((start + 11) % 12)) continue;
    let len = 0;
    while (set.has((start + len) % 12)) len++;
    if (len === ms.length) return len === 1 ? MONTHS[start] : `${MONTHS[start]} to ${MONTHS[(start + len - 1) % 12]}`;
  }
  return ms.map((m) => MONTHS[m]).join(", ");
}

function renderTable(cells: ReturnType<typeof buildCells>): void {
  const years = [...new Set(cells.map((c) => c.year))];
  const head = `<thead><tr><th scope="col">Year</th>${MONTHS.map((m) => `<th scope="col">${m}</th>`).join("")}</tr></thead>`;
  const body = years
    .map((y) => {
      const tds = cells
        .filter((c) => c.year === y)
        .map((c) => `<td>${c.value === null ? "–" : fmtInt.format(c.value)}</td>`)
        .join("");
      return `<tr><th scope="row">${y}</th>${tds}</tr>`;
    })
    .join("");
  $("table-host").innerHTML = `<table class="cal-table"><caption class="visually-hidden">Monthly hotspots</caption>${head}<tbody>${body}</tbody></table>`;
}

function periodTotal(s: Series): number {
  let t = 0;
  s.months.forEach((m, i) => {
    const y = +m.slice(0, 4);
    if (y >= state.from && y <= state.to) t += valueAt(s, "harmonized", i) ?? 0;
  });
  return t;
}

function selectFromMap(id: string): void {
  update({ r: id });
  $("calendar-section").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function renderMapNow(): void {
  const totals = new Map<string, number>();
  for (const [id, s] of allSeries) totals.set(id, periodTotal(s));
  renderMap($("map-host"), state.layer, totals, names, state.r, selectFromMap);
  renderRanking(totals);
}

/** Regions of the current map layer ordered by total, with a bar scaled to the largest. */
function renderRanking(totals: Map<string, number>): void {
  const kind = state.layer === "states" ? "state" : "biome";
  const rows = regions
    .filter((r) => r.kind === kind && totals.has(r.id))
    .map((r) => ({ r, v: totals.get(r.id) ?? 0 }))
    .sort((a, b) => b.v - a.v);
  const host = $("rank-host");
  const span = state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`;
  $("rank-title").textContent = `${state.layer === "states" ? "States" : "Biomes"} by harmonized hotspots, ${span}`;
  if (!rows.length) {
    host.innerHTML = "";
    return;
  }
  const brazil = totals.get("BR") ?? rows.reduce((a, x) => a + x.v, 0);
  const max = rows[0].v || 1;
  host.replaceChildren(
    ...rows.map(({ r, v }) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = r.id === state.r ? "rank-row is-selected" : "rank-row";
      b.setAttribute("aria-pressed", String(r.id === state.r));
      const share = brazil ? (100 * v) / brazil : 0;
      b.innerHTML =
        `<span class="rank-name">${r.name}</span>` +
        `<span class="rank-value">${fmtInt.format(v)}</span>` +
        `<span class="rank-share">${share < 1 ? "<1" : Math.round(share)}%</span>` +
        `<span class="rank-bar" aria-hidden="true"><span style="width:${((100 * v) / max).toFixed(1)}%"></span></span>`;
      b.addEventListener("click", () => selectFromMap(r.id));
      li.append(b);
      return li;
    }),
  );
}

function downloadCSV(): void {
  if (!current) return;
  const header = "region,month,harmonized,lo,hi,source,modis_raw,viirs_raw,naive,qa_flag";
  const lines = current.months
    .map((m, i) => ({ m, i, y: +m.slice(0, 4) }))
    .filter(({ y }) => y >= state.from && y <= state.to)
    .map(({ m, i }) =>
      [current!.region, m, current!.harmonized[i], current!.lo[i], current!.hi[i], current!.source[i],
        current!.modis_raw[i], current!.viirs_raw[i] ?? "", current!.naive[i], current!.qa_flag[i]].join(","),
    );
  const blob = new Blob([[header, ...lines].join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `brasa_${current.region}_${state.from}-${state.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderMethod(): void {
  if (!meta) return;
  const p = meta.proof;
  $("proof-text").textContent =
    `Joined naively, Brazil's hotspots jump ${fmt1.format(p.naive.step_2012)}× from 2009–2011 to 2012–2014, and the record shows a false rising trend ` +
    `(+${fmt1.format(p.naive.trend.sen_slope_pct_of_mean)}% per year, ${fmtP(p.naive.trend.p)}). After harmonization the same step is ` +
    `${fmt2.format(p.harmonized.step_2012)}×, matching MODIS alone (${fmt2.format(p.modis_raw.step_2012)}×): the jump was the sensor, not the fires.`;
  $("n-detections").textContent = fmtInt.format(meta.build.detections_type0_dedup);
  $("n-calib").textContent = String(meta.calibration_months);
  renderBeforeAfter($("before-after"), meta);

  const desc: Record<string, string> = {
    C0: "No harmonization (naive splice)",
    C1: "One ratio for all of Brazil",
    C2: "One ratio per region",
    C3: "Log-log regression per region",
    C4: "Log-log per region + fire-season term",
  };
  const rows = Object.entries(meta.cv_summary)
    .map(([k, m]) => {
      const sel = k === meta!.selected_model;
      return `<tr${sel ? ' class="is-selected"' : ""}><th scope="row">${desc[k] ?? k}${sel ? " <span>(used)</span>" : ""}</th><td>${fmt2.format(m.rmse_log)}</td><td>${m.r2_log < 0 ? fmtSigned(m.r2_log, fmt2) : fmt2.format(m.r2_log)}</td><td>${Math.round(100 * m.mean_abs_bias)}%</td></tr>`;
    })
    .join("");
  $("metrics").innerHTML = `<caption class="visually-hidden">Cross-validated model comparison</caption><thead><tr><th scope="col">Model</th><th scope="col">RMSE <span class="unit">(log)</span></th><th scope="col">R² <span class="unit">(log)</span></th><th scope="col">Bias <span class="unit">(mean abs.)</span></th></tr></thead><tbody>${rows}</tbody>`;
  const s = meta.sensitivity_br_ratio;
  $("sensitivity").textContent =
    `In Brazil, VIIRS reports ${fmt2.format(s.default_nominal_high)}× the hotspots of MODIS over 2012–2025 ` +
    `(${fmt2.format(s.including_low_confidence)}× if low-confidence detections are kept, ${fmt2.format(s.daytime_only)}× for daytime only). ` +
    `Counting fire-days on a 0.1° grid instead of pixels narrows the gap to ${fmt2.format(s["fire_cell_days_0.1deg"])}×, which shows how much of the difference comes from pixel size.`;
  if (meta.provisional) {
    const [y, mo] = meta.provisional.through.split("-");
    $("key-provisional").hidden = false;
    const [fy, fm] = meta.provisional.from.split("-");
    const range = fy === y ? `${MONTHS[+fm - 1]} to ${MONTHS[+mo - 1]} ${y}` : `${MONTHS[+fm - 1]} ${fy} to ${MONTHS[+mo - 1]} ${y}`;
    $("key-provisional-text").textContent = `${range}: provisional, from NASA's near-real-time feed`;
    $("limit-current").textContent = `${range} come from NASA's near-real-time and standard-processing feeds. These months are provisional until NASA publishes the yearly archive, and they are never used to fit the models.`;
  }
  $("generated").textContent = `Data processed ${meta.generated_utc.replace("T", " ").replace("Z", " UTC")}.`;
}

function renderAll(): void {
  render();
  if (meta) renderBeforeAfter($("before-after"), meta);
  if (validation) renderValidation($("validation-host"), validation, names);
}

// Mobile browsers fire "resize" when the URL bar hides on scroll; only a width change needs a re-render.
let resizeTimer = 0;
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderAll, 150);
});
// Chart colours are read from CSS tokens at render time, so redraw when the OS theme changes.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);

async function init(): Promise<void> {
  try {
    const [regs, m] = await Promise.all([loadRegions(), loadMeta()]);
    regions = regs;
    meta = m;
    if (m.span?.[1]) setSpan(m.span[1]);
    state = readState(); // the year range depends on the data span in meta.json
    names = new Map(regions.map((r) => [r.id, r.name]));
    fillControls();
    initHero(m).catch(() => {
      $("hero-fallback").hidden = false;
      for (const el of document.querySelectorAll(".hero-map, .hero-readout, .hero-caption, .hero-actions, .hero-stories"))
        el.setAttribute("hidden", "");
    });
    await update({});
    renderMethod();
  } catch (err) {
    showError(`Brasa could not load its data. Reload the page to try again. (${(err as Error).message})`);
    return;
  }
  // Secondary data: map boundaries, every region for map totals, validation points.
  loadBoundaries()
    .then((t) => {
      setTopology(t);
      return Promise.all(regions.map((r) => loadSeries(r.id).then((s) => allSeries.set(r.id, s))));
    })
    .then(renderMapNow)
    .catch(() => ($("map-host").textContent = "The map could not be loaded. The calendar still works."));
  loadValidation()
    .then((v) => {
      validation = v;
      renderValidation($("validation-host"), v, names);
    })
    .catch(() => ($("validation-host").textContent = "Validation points could not be loaded."));
}

init();
