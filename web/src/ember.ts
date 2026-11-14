import * as d3 from "d3";
import { feature, mesh } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { MONTHS, type Series } from "./data";
import { fmtInt } from "./stats";

/** Animated monthly hotspot map (grid.bin from pipeline/grid.py) with a scrubbable timeline. */

export type EmberMode = "harmonized" | "raw";

interface GridMeta {
  lon0: number; lat0: number; step: number; ncols: number; nrows: number;
  months: string[]; offsets: number[]; n: number; overlap_start: string; vmax: number;
}

interface Grid { meta: GridMeta; cell: Uint16Array; raw: Uint8Array; harm: Uint8Array }

const MONTHS_PER_SECOND = 12;
const SATURATE = 0.8; // share of the top cell count that already renders at full heat
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf; // already decoded by the server
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

export async function loadGrid(): Promise<Grid> {
  const [meta, bin] = await Promise.all([
    fetch("./data/grid.json").then((r) => {
      if (!r.ok) throw new Error(`grid.json HTTP ${r.status}`);
      return r.json() as Promise<GridMeta>;
    }),
    fetch("./data/grid.bin").then((r) => {
      if (!r.ok) throw new Error(`grid.bin HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const buf = await gunzip(bin);
  const n = meta.n;
  if (buf.byteLength !== n * 4) throw new Error("grid.bin has an unexpected size");
  const cell = new Uint16Array(buf, 0, n).slice();
  const raw = new Uint8Array(buf, 2 * n, n).slice();
  const diff = new Int8Array(buf, 3 * n, n);
  const harm = new Uint8Array(n);
  for (let i = 0; i < n; i++) harm[i] = raw[i] + diff[i];
  // cells are delta-coded within each month
  for (let t = 0; t < meta.months.length; t++) {
    for (let i = meta.offsets[t] + 1; i < meta.offsets[t + 1]; i++) cell[i] = cell[i] + cell[i - 1];
  }
  return { meta, cell, raw, harm };
}

/** 256-entry ember ramp: deep red embers, orange flame, a pale yellow core. Premultiplied RGBA. */
function emberLUT(vmax: number): Uint8ClampedArray {
  const stops = [
    [0, [90, 14, 6, 0]],
    [0.15, [120, 22, 8, 90]],
    [0.4, [200, 55, 15, 210]],
    [0.7, [250, 140, 40, 255]],
    [1, [255, 236, 170, 255]],
  ] as const;
  const lut = new Uint8ClampedArray(256 * 4);
  for (let q = 0; q < 256; q++) {
    // Levels store log counts. Brightness follows the square root of the count instead, which keeps
    // a 4x jump visibly 2x brighter (the log scale would flatten it) and leaves stray detections dim.
    const v = Math.expm1((q / 255) * Math.log1p(vmax));
    const x = Math.min(1, Math.sqrt(v / (vmax * SATURATE)));
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, c0] = stops[k];
    const [x1, c1] = stops[k + 1];
    const f = (x - x0) / (x1 - x0);
    for (let j = 0; j < 4; j++) lut[q * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return lut;
}

export interface EmberOptions {
  canvas: HTMLCanvasElement;
  timeline: HTMLElement;
  topology: unknown;
  grid: Grid;
  national: Series;
  onFrame: (info: { month: string; index: number; value: number; mode: EmberMode }) => void;
}

export class EmberMap {
  private o: EmberOptions;
  private lut: Uint8ClampedArray;
  private small: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private img: ImageData;
  private a: Uint8Array;
  private b: Uint8Array;
  private aT = -1;
  private bT = -1;
  private base: HTMLCanvasElement | null = null;
  private place = { x: 0, y: 0, w: 0, h: 0 };
  private path: d3.GeoPath | null = null;
  private pantanal: d3.GeoPermissibleObjects | null = null;
  private highlight = false;
  private t = 0;
  private playing = false;
  private stopAt = Infinity;
  private speed = MONTHS_PER_SECOND;
  private onEnd: (() => void) | null = null;
  private last = 0;
  private raf = 0;
  private visible = true;
  private lastReported = -1;
  mode: EmberMode = "harmonized";
  onPlayState: (playing: boolean) => void = () => {};

  constructor(o: EmberOptions) {
    this.o = o;
    this.lut = emberLUT(o.grid.meta.vmax);
    const { ncols, nrows } = o.grid.meta;
    this.small = document.createElement("canvas");
    this.small.width = ncols;
    this.small.height = nrows;
    this.sctx = this.small.getContext("2d")!;
    this.img = this.sctx.createImageData(ncols, nrows);
    this.a = new Uint8Array(ncols * nrows);
    this.b = new Uint8Array(ncols * nrows);
    const topo = o.topology as Topology;
    const biomes = feature(topo, topo.objects.biomes as GeometryCollection) as unknown as {
      features: { properties: { biome?: string } }[];
    };
    this.pantanal = (biomes.features.find((f) => f.properties.biome === "PAN") ?? null) as d3.GeoPermissibleObjects | null;
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) this.kick();
    }).observe(o.canvas);
    document.addEventListener("visibilitychange", () => this.kick());
    this.resize();
    this.buildTimeline();
  }

  get months(): string[] { return this.o.grid.meta.months; }
  get index(): number { return Math.round(this.t); }
  get isPlaying(): boolean { return this.playing; }

  /** Lay out the canvas for its current CSS size and pre-render the outline layer. */
  resize(): void {
    const c = this.o.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(280, c.clientWidth);
    const { lon0, lat0, step, ncols, nrows } = this.o.grid.meta;
    const lon1 = lon0 + ncols * step;
    const lat1 = lat0 + nrows * step;
    // Plain equirectangular: the 0.25° grid maps linearly onto the canvas, and so does the outline.
    const h = Math.round((w * nrows) / ncols);
    c.style.height = `${h}px`;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const proj = d3.geoEquirectangular().scale(1).translate([0, 0]);
    const p0 = proj([lon0, lat1])!;
    const p1 = proj([lon1, lat0])!;
    const k = c.width / (p1[0] - p0[0]);
    proj.scale(k).translate([-p0[0] * k, -p0[1] * k]);
    this.place = { x: 0, y: 0, w: c.width, h: c.height };
    this.path = d3.geoPath(proj);

    const base = document.createElement("canvas");
    base.width = c.width;
    base.height = c.height;
    const bx = base.getContext("2d")!;
    const topo = this.o.topology as Topology;
    const states = topo.objects.states as GeometryCollection;
    const gp = d3.geoPath(proj, bx);
    bx.lineJoin = "round";
    bx.beginPath();
    gp(mesh(topo, states, (a, b) => a !== b) as d3.GeoPermissibleObjects);
    bx.strokeStyle = "rgba(190, 205, 225, 0.16)";
    bx.lineWidth = 0.8 * dpr;
    bx.stroke();
    bx.beginPath();
    gp(mesh(topo, states, (a, b) => a === b) as d3.GeoPermissibleObjects);
    bx.strokeStyle = "rgba(200, 215, 235, 0.42)";
    bx.lineWidth = 1.1 * dpr;
    bx.stroke();
    this.base = base;
    this.dpr = dpr;
    this.aT = this.bT = -1;
    this.draw();
    this.drawTimeline();
  }

  private dpr = 1;

  private decode(t: number, into: Uint8Array): void {
    into.fill(0);
    const g = this.o.grid;
    const lv = this.mode === "raw" ? g.raw : g.harm;
    for (let i = g.meta.offsets[t]; i < g.meta.offsets[t + 1]; i++) into[g.cell[i]] = lv[i];
  }

  private draw(): void {
    const n = this.months.length;
    const t0 = Math.min(n - 1, Math.floor(this.t));
    const t1 = Math.min(n - 1, t0 + 1);
    const f = this.t - t0;
    if (this.aT !== t0) {
      if (this.bT === t0) {
        [this.a, this.b] = [this.b, this.a];
        this.bT = this.aT;
      } else this.decode(t0, this.a);
      this.aT = t0;
    }
    if (this.bT !== t1) {
      this.decode(t1, this.b);
      this.bT = t1;
    }
    const { ncols, nrows } = this.o.grid.meta;
    const px = this.img.data;
    const lut = this.lut;
    const A = this.a;
    const B = this.b;
    for (let row = 0; row < nrows; row++) {
      const yo = (nrows - 1 - row) * ncols; // grid row 0 is the southern edge
      const ro = row * ncols;
      for (let col = 0; col < ncols; col++) {
        const q = Math.round(A[ro + col] * (1 - f) + B[ro + col] * f);
        const p = (yo + col) * 4;
        const l = q * 4;
        px[p] = lut[l]; px[p + 1] = lut[l + 1]; px[p + 2] = lut[l + 2]; px[p + 3] = lut[l + 3];
      }
    }
    this.sctx.putImageData(this.img, 0, 0);

    const c = this.o.canvas;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.base) ctx.drawImage(this.base, 0, 0);
    const { x, y, w, h } = this.place;
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = "lighter";
    // soft glow, then the embers themselves
    // On narrow screens a 0.25° cell is only 1-2 px wide, so the embers get a wider glow and a
    // second additive pass to stay as legible as on desktop.
    const narrow = c.width / this.dpr < 600;
    ctx.filter = `blur(${Math.round((narrow ? 3 : 5) * this.dpr)}px)`;
    ctx.globalAlpha = narrow ? 1 : 0.75;
    ctx.drawImage(this.small, x, y, w, h);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.small, x, y, w, h);
    if (narrow) ctx.drawImage(this.small, x, y, w, h);
    ctx.globalCompositeOperation = "source-over";
    if (this.highlight && this.pantanal && this.path) {
      ctx.beginPath();
      d3.geoPath(this.path.projection() as d3.GeoProjection, ctx)(this.pantanal);
      ctx.strokeStyle = "rgba(255, 236, 190, 0.95)";
      ctx.lineWidth = 2 * this.dpr;
      ctx.setLineDash([5 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const i = Math.round(this.t);
    if (i !== this.lastReported) {
      this.lastReported = i;
      const s = this.o.national;
      const j = s.months.indexOf(this.months[i]);
      const v = j < 0 ? 0 : this.mode === "raw" ? s.naive[j] : s.harmonized[j];
      this.o.onFrame({ month: this.months[i], index: i, value: v, mode: this.mode });
      this.moveHead();
    }
  }

  // ---------- timeline ----------
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private x = d3.scaleLinear();
  private headX = 0;

  private buildTimeline(): void {
    const host = this.o.timeline;
    host.tabIndex = 0;
    host.setAttribute("role", "slider");
    host.setAttribute("aria-label", "Month shown on the map");
    host.setAttribute("aria-valuemin", "0");
    host.setAttribute("aria-valuemax", String(this.months.length - 1));
    const seek = (ev: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const i = Math.round(this.x.invert(ev.clientX - r.left));
      this.pause();
      this.seek(Math.max(0, Math.min(this.months.length - 1, i)));
    };
    host.addEventListener("pointerdown", (ev) => {
      host.setPointerCapture(ev.pointerId);
      seek(ev);
      const move = (e: PointerEvent) => seek(e);
      const up = () => {
        host.removeEventListener("pointermove", move);
        host.removeEventListener("pointerup", up);
        host.removeEventListener("pointercancel", up);
      };
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerup", up);
      host.addEventListener("pointercancel", up);
    });
    host.addEventListener("keydown", (ev) => {
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -12, PageUp: 12 };
      let i = this.index;
      if (ev.key in steps) i += steps[ev.key];
      else if (ev.key === "Home") i = 0;
      else if (ev.key === "End") i = this.months.length - 1;
      else if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        this.toggle();
        return;
      } else return;
      ev.preventDefault();
      this.pause();
      this.seek(Math.max(0, Math.min(this.months.length - 1, i)));
    });
  }

  drawTimeline(): void {
    const host = this.o.timeline;
    const width = Math.max(280, host.clientWidth);
    const height = 76;
    const m = { l: 4, r: 4, t: 8, b: 22 };
    const s = this.o.national;
    const idx = this.months.map((mm) => s.months.indexOf(mm));
    const vals = idx.map((j) => (j < 0 ? 0 : this.mode === "raw" ? s.naive[j] : s.harmonized[j]));
    const ymax = d3.max([...s.harmonized, ...s.naive]) ?? 1;
    this.x = d3.scaleLinear().domain([0, this.months.length - 1]).range([m.l, width - m.r]);
    const y = d3.scaleLinear().domain([0, ymax]).range([height - m.b, m.t]);
    d3.select(host).selectAll("svg").remove();
    const svg = d3.select(host).append("svg").attr("width", width).attr("height", height).attr("aria-hidden", "true");
    const area = d3.area<number>().x((_, i) => this.x(i)).y0(height - m.b).y1((v) => y(v)).curve(d3.curveMonotoneX);
    svg.append("path").attr("class", "tl-area").attr("d", area(vals));
    const split = this.months.indexOf(this.o.grid.meta.overlap_start);
    if (split > 0) {
      svg.append("line").attr("class", "tl-split").attr("x1", this.x(split)).attr("x2", this.x(split)).attr("y1", m.t).attr("y2", height - m.b);
    }
    const lastY = +this.months[this.months.length - 1].slice(0, 4);
    const years = [2001, 2005, 2012, 2016, 2020, lastY].filter((yy, k, a) => a.indexOf(yy) === k && this.months.includes(`${yy}-01`));
    const narrow = width < 520;
    svg.append("g").selectAll("text").data(years.filter((yy) => !narrow || [2001, 2012, 2020, lastY].includes(yy))).join("text")
      .attr("class", (yy) => (yy === 2012 ? "tl-year tl-year-split" : "tl-year"))
      .attr("x", (yy) => this.x(this.months.indexOf(`${yy}-01`)))
      .attr("y", height - 6)
      .attr("text-anchor", (yy, k, all) => (k === 0 ? "start" : k === all.length - 1 ? "end" : "middle"))
      .text((yy) => String(yy));
    svg.append("line").attr("class", "tl-head").attr("y1", m.t - 4).attr("y2", height - m.b);
    svg.append("circle").attr("class", "tl-knob").attr("r", 5).attr("cy", height - m.b);
    this.svg = svg;
    this.moveHead();
  }

  private moveHead(): void {
    if (!this.svg) return;
    const i = this.index;
    this.headX = this.x(i);
    this.svg.select(".tl-head").attr("x1", this.headX).attr("x2", this.headX);
    this.svg.select(".tl-knob").attr("cx", this.headX);
    const h = this.o.timeline;
    const [yy, mm] = this.months[i].split("-");
    h.setAttribute("aria-valuenow", String(i));
    h.setAttribute("aria-valuetext", `${MONTHS[+mm - 1]} ${yy}`);
  }

  // ---------- playback ----------
  seek(i: number): void {
    this.t = Math.max(0, Math.min(this.months.length - 1, i));
    this.draw();
  }

  monthIndex(ym: string): number {
    return this.months.indexOf(ym);
  }

  setMode(mode: EmberMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.aT = this.bT = -1;
    this.lastReported = -1;
    this.draw();
    this.drawTimeline();
  }

  setHighlight(on: boolean): void {
    if (on === this.highlight) return;
    this.highlight = on;
    this.draw();
  }

  /** Play from `from` (default: the current month) to `to` (default: the end); `onEnd` runs only
   *  when playback reaches `to`, not when it is paused or replaced. */
  play(from?: number, to?: number, speed = MONTHS_PER_SECOND, onEnd: (() => void) | null = null): void {
    const end = this.months.length - 1;
    if (from !== undefined) this.t = from;
    else if (this.t >= end) this.t = 0;
    this.stopAt = to ?? end;
    this.speed = speed;
    this.onEnd = onEnd;
    this.aT = this.bT = -1;
    this.playing = true;
    this.onPlayState(true);
    this.kick();
  }

  pause(): void {
    this.onEnd = null;
    if (!this.playing) return;
    this.playing = false;
    this.t = Math.round(this.t);
    this.onPlayState(false);
    this.draw();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private kick(): void {
    if (this.raf || !this.playing || !this.visible || document.hidden) return;
    this.last = performance.now();
    const step = (now: number) => {
      this.raf = 0;
      if (!this.playing || !this.visible || document.hidden) return;
      const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000)); // rAF time can precede performance.now()
      this.last = now;
      this.t = Math.min(this.stopAt, this.t + dt * this.speed);
      this.draw();
      if (this.t >= this.stopAt) {
        this.playing = false;
        this.t = Math.round(this.t);
        this.onPlayState(false);
        const cb = this.onEnd;
        this.onEnd = null;
        cb?.();
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  static get reducedMotion(): boolean { return REDUCED.matches; }
}

export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[+m - 1]} ${y}`;
}

export const fmtCount = (v: number) => fmtInt.format(v);
