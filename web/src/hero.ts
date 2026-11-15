import { loadBoundaries, loadSeries, type Meta } from "./data";
import { EmberMap, fmtMonth, loadGrid, type EmberMode } from "./ember";
import { fmt1, fmtInt } from "./stats";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Guided stories: a region outline and a dry season that stands out on the harmonized record.
 *  Figures come from the harmonized monthly series (2001 to 2025). */
const STORIES = {
  pantanal: {
    outline: "biome:PAN",
    year: 2020,
    from: "2019-10",
    before: "The dashed outline is the Pantanal. Watch it from January 2020.",
    during: "Pantanal, 2020: ahead of every earlier year from January, long before the September peak. About 30% of the biome burned.",
  },
  cerrado: {
    outline: "biome:CER",
    year: 2010,
    from: "2009-12",
    before: "The dashed outline is the Cerrado. Watch its 2010 dry season.",
    during: "Cerrado, 2010: its worst year in the record, 2.5× the median year. On the raw record it ranks only 15th, below every year since 2012.",
  },
  amazonas: {
    outline: "state:AM",
    year: 2024,
    from: "2023-12",
    to: "2024-08",
    before: "The dashed outline is the state of Amazonas. Watch its 2024 dry season.",
    during: "Amazonas, 2024: the state's worst year in the record, 2.9× the median. A historic drought set monthly records from June to September.",
  },
} as const;
type Story = keyof typeof STORIES | "2012";
const STORY_BUTTONS: Record<string, keyof typeof STORIES> = {
  "hero-2020": "pantanal",
  "hero-cerrado": "cerrado",
  "hero-amazonas": "amazonas",
};

/** Opening scene: the animated ember map, its readout and two guided stories. */
export async function initHero(meta: Meta | null): Promise<void> {
  const canvas = $<HTMLCanvasElement>("ember");
  if (!("DecompressionStream" in window) || !canvas.getContext("2d")) throw new Error("unsupported browser");
  const [grid, topology, national] = await Promise.all([loadGrid(), loadBoundaries(), loadSeries("BR")]);
  const ratio = meta?.k_global_viirs_per_modis ?? 3.8;
  const split = grid.meta.overlap_start;
  const months = grid.meta.months;
  const lastYear = months[months.length - 1].slice(0, 4);
  const provFrom = meta?.provisional?.from ?? "9999-99";
  canvas.setAttribute("aria-label", `Map of Brazil where each fire hotspot glows, month by month from 2001 to ${lastYear}.`);
  let story: Story | null = null;
  let timer = 0;

  const caption = (ym: string, mode: EmberMode): string => {
    const y = +ym.slice(0, 4);
    if (ym >= provFrom && !story)
      return `${y}, provisional: near-real-time VIIRS data, updated until the yearly archive is published.`;
    const guided = story && story !== "2012" ? STORIES[story] : null;
    if (guided && (y === guided.year || y === guided.year - 1)) return y === guided.year ? guided.during : guided.before;
    if (mode === "raw") {
      if (ym < split) return "Raw record: MODIS only. Its instrument sees fewer fires than the one that comes next.";
      if (y === 2012) return `January 2012: the record switches to VIIRS, which sees about ${fmt1.format(ratio)}× more hotspots. The jump is the sensor, not the fire.`;
      return "Raw record: VIIRS from 2012 on. Next to it, every year before 2012 looks small.";
    }
    if (y >= 2010 && y <= 2013) return "Harmonized: the MODIS years are calibrated onto the VIIRS scale. No jump in 2012.";
    return `Harmonized: one scale from 2001 to ${lastYear}. Brighter cells had more hotspots that month.`;
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
    map.setHighlight(null);
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
    // End both passes on the September 2012 peak, where the jump is largest.
    map.play(at("2010-01"), at("2012-09"), 9, () => {
      timer = window.setTimeout(() => {
        setMode("harmonized");
        map.play(at("2010-01"), at("2012-09"), 9, () => (story = null));
      }, 1600);
    });
  });
  for (const [id, key] of Object.entries(STORY_BUTTONS)) {
    $(id).addEventListener("click", () => {
      const s = STORIES[key];
      endStory();
      story = key;
      setMode("harmonized");
      map.setHighlight(s.outline);
      map.play(at(s.from), at("to" in s ? s.to : `${s.year}-09`), 2.5);
    });
  }

  let lastW = canvas.clientWidth;
  new ResizeObserver(() => {
    if (canvas.clientWidth === lastW) return;
    lastW = canvas.clientWidth;
    map.resize();
  }).observe(canvas.parentElement!);

  if (EmberMap.reducedMotion) map.seek(at("2020-09"));
  else map.play(0);
}
