import * as d3 from "d3";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { fmtInt } from "./stats";

export type MapLayer = "states" | "biomes";

interface Feat {
  type: "Feature";
  properties: { uf?: string; biome?: string; name?: string; name_muni?: string };
  geometry: d3.GeoPermissibleObjects;
}

let topo: Topology | null = null;

export function setTopology(t: unknown): void {
  topo = t as Topology;
  featCache.clear();
}

/** d3-geo is spherical: a ring wound the "wrong" way covers the whole globe. Reverse those rings. */
function rewind(f: Feat): Feat {
  const g = f.geometry as { type: string; coordinates: number[][][] | number[][][][] };
  const fixPoly = (poly: number[][][]) => {
    const area = d3.geoArea({ type: "Polygon", coordinates: poly } as d3.GeoPermissibleObjects);
    return area > 2 * Math.PI ? poly.map((ring) => [...ring].reverse()) : poly;
  };
  if (g.type === "Polygon") g.coordinates = fixPoly(g.coordinates as number[][][]);
  else if (g.type === "MultiPolygon") g.coordinates = (g.coordinates as number[][][][]).map(fixPoly);
  return f;
}

const featCache = new Map<string, Feat[]>();
function feats(name: string): Feat[] {
  if (!topo) return [];
  let f = featCache.get(name);
  if (!f) {
    f = (feature(topo, topo.objects[name] as GeometryCollection) as unknown as { features: Feat[] }).features.map(rewind);
    featCache.set(name, f);
  }
  return f;
}

export function regionIdOf(f: Feat, layer: MapLayer): string {
  return layer === "states" ? `UF_${f.properties.uf}` : `BIOME_${f.properties.biome}`;
}

/** Choropleth of totals for the selected period; click selects a region. */
export function renderMap(
  host: HTMLElement,
  layer: MapLayer,
  totals: Map<string, number>,
  names: Map<string, string>,
  selected: string,
  onSelect: (id: string) => void,
): void {
  if (!topo) return;
  const width = Math.min(560, Math.max(300, host.clientWidth));
  const height = Math.round(width * 0.95);
  const fs = feats(layer);
  const rmc = feats("rmc");
  const projection = d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features: fs } as never);
  const path = d3.geoPath(projection);
  const max = d3.max(fs, (f) => totals.get(regionIdOf(f, layer)) ?? 0) || 1;
  const color = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([Math.max(1, max / 1000), max]).clamp(true);

  host.replaceChildren();
  const svg = d3
    .select(host)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("role", "group")
    .attr("aria-label", `Map of ${layer === "states" ? "states" : "biomes"} coloured by total hotspots. Choose a region to show its calendar.`);

  svg
    .append("g")
    .selectAll("path")
    .data(fs)
    .join("path")
    .attr("class", (f) => `region${regionIdOf(f, layer) === selected ? " is-selected" : ""}`)
    .attr("d", (f) => path(f.geometry as never) ?? "")
    .attr("fill", (f) => color(Math.max(1, totals.get(regionIdOf(f, layer)) ?? 1)))
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (f) => {
      const id = regionIdOf(f, layer);
      return `${names.get(id) ?? id}: ${fmtInt.format(totals.get(id) ?? 0)} hotspots`;
    })
    .on("click", (_, f) => onSelect(regionIdOf(f, layer)))
    .on("keydown", (ev: KeyboardEvent, f) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onSelect(regionIdOf(f, layer));
      }
    })
    .append("title")
    .text((f) => {
      const id = regionIdOf(f, layer);
      return `${names.get(id) ?? id}: ${fmtInt.format(totals.get(id) ?? 0)} hotspots`;
    });

  const rmcPath = svg
    .append("g")
    .attr("class", `rmc${selected === "RMC" ? " is-selected" : ""}`)
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", "Campinas Metro Area")
    .on("click", () => onSelect("RMC"))
    .on("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onSelect("RMC");
      }
    });
  rmcPath.selectAll("path").data(rmc).join("path").attr("d", (f) => path(f.geometry as never) ?? "");
  const c = d3.geoCentroid({ type: "FeatureCollection", features: rmc } as never);
  const [x, y] = projection(c) ?? [0, 0];
  rmcPath.append("circle").attr("cx", x).attr("cy", y).attr("r", 5);
  rmcPath.append("title").text("Campinas Metro Area");
}
