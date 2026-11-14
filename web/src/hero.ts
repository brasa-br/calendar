import { loadBoundaries, loadSeries, type Meta } from "./data";
import { EmberMap, fmtMonth, loadGrid, type EmberMode } from "./ember";
import { fmt1, fmtInt } from "./stats";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Opening scene: the animated ember map, its readout and two guided stories. */
export async function initHero(meta: Meta | null): Promise<void> {
  const canvas = $<HTMLCanvasElement>("ember");
  if (!("DecompressionStream" in window) || !canvas.getContext("2d")) throw new Error("unsupported browser");
  const [grid, topology, national] = await Promise.all([loadGrid(), loadBoundaries(), loadSeries("BR")]);
  const ratio = meta?.k_global_viirs_per_modis ?? 3.8;
  const split = grid.meta.overlap_start;
  let story: "2012" | "2020" | null = null;
  let timer = 0;

  const caption = (ym: string, mode: EmberMode): string => {
    const y = +ym.slice(0, 4);
    if (story === "2020" && y >= 2019 && y <= 2020)
      return y === 2020
        ? "Pantanal, 2020: ahead of every earlier year from January, long before the September peak. About 30% of the biome burned."
        : "The dashed outline is the Pantanal. Watch it from January 2020.";
    if (mode === "raw") {
      if (ym < split) return "Raw record: MODIS only. Its instrument sees fewer fires than the one that comes next.";
      if (y === 2012) return `January 2012: the record switches to VIIRS, which sees about ${fmt1.format(ratio)}× more hotspots. The jump is the sensor, not the fire.`;
      return "Raw record: VIIRS from 2012 on. Next to it, every year before 2012 looks small.";
    }
    if (y >= 2010 && y <= 2013) return "Harmonized: the MODIS years are calibrated onto the VIIRS scale. No jump in 2012.";
    return "Harmonized: one scale from 2001 to 2025. Brighter cells had more hotspots that month.";
  };

  const map = new EmberMap({
    canvas,
    timeline: $("ember-timeline"),
    topology,
    grid,
    national,
    onFrame: ({ month, value, mode }) => {
      $("hero-month").textContent = fmtMonth(month);
      $("hero-count").textContent = fmtInt.format(value);
      $("hero-caption").textContent = caption(month, mode);
    },
  });

  const play = $<HTMLButtonElement>("hero-play");
  map.onPlayState = (on) => {
    play.textContent = on ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(on));
  };
  const setMode = (mode: EmberMode) => {
    const input = document.querySelector<HTMLInputElement>(`input[name="hm"][value="${mode}"]`);
    if (input) input.checked = true;
    map.setMode(mode);
  };
  const endStory = () => {
    clearTimeout(timer);
    story = null;
    map.setHighlight(false);
  };
  // Any direct interaction ends a guided story.
  $("ember-timeline").addEventListener("pointerdown", endStory);
  $("ember-timeline").addEventListener("keydown", endStory);
  play.addEventListener("click", () => {
    endStory();
    map.toggle();
  });
  $("hero-mode").addEventListener("change", (e) => {
    endStory();
    map.setMode((e.target as HTMLInputElement).value as EmberMode);
  });

  const at = (ym: string) => Math.max(0, map.monthIndex(ym));
  $("hero-2012").addEventListener("click", () => {
    endStory();
    story = "2012";
    setMode("raw");
    map.play(at("2010-01"), at("2012-12"), 9, () => {
      timer = window.setTimeout(() => {
        setMode("harmonized");
        map.play(at("2010-01"), at("2012-12"), 9, () => (story = null));
      }, 1600);
    });
  });
  $("hero-2020").addEventListener("click", () => {
    endStory();
    story = "2020";
    setMode("harmonized");
    map.setHighlight(true);
    map.play(at("2019-10"), at("2020-09"), 4);
  });

  let lastW = canvas.clientWidth;
  new ResizeObserver(() => {
    if (canvas.clientWidth === lastW) return;
    lastW = canvas.clientWidth;
    map.resize();
  }).observe(canvas.parentElement!);

  if (EmberMap.reducedMotion) map.seek(at("2020-09"));
  else map.play(0);
}
