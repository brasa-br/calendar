"""Boundaries (geobr / IBGE) and point -> region lookup."""
from __future__ import annotations

import json
import warnings

import geopandas as gpd
import pandas as pd

from . import config as C

warnings.filterwarnings("ignore")

_CACHE = C.INTERIM / "boundaries.gpkg"


def load_boundaries() -> dict[str, gpd.GeoDataFrame]:
    """Return {'states','biomes','rmc','country'} in EPSG:4326, cached locally."""
    C.INTERIM.mkdir(parents=True, exist_ok=True)
    if _CACHE.exists():
        return {k: gpd.read_file(_CACHE, layer=k) for k in ("states", "biomes", "rmc", "country")}
    import geobr

    states = geobr.read_state(year=2020)[["abbrev_state", "name_state", "geometry"]]
    states = states.rename(columns={"abbrev_state": "uf", "name_state": "name"})
    biomes = geobr.read_biomes(year=2019)
    biomes = biomes[biomes["name_biome"].isin(C.BIOME_CODES)].copy()
    biomes["biome"] = biomes["name_biome"].map(C.BIOME_CODES)
    biomes["name"] = biomes["biome"].map(C.BIOME_NAMES_EN)
    biomes = biomes[["biome", "name", "geometry"]].dissolve(by="biome", as_index=False)
    metro = geobr.read_metro_area(year=2018)
    rmc = metro[metro["name_metro"].str.contains("Campinas")][["code_muni", "name_muni", "geometry"]]
    country = states.dissolve()[["geometry"]]
    out = {"states": states, "biomes": biomes, "rmc": rmc, "country": country}
    for k, g in out.items():
        g = g.to_crs(4326)
        g["geometry"] = g.geometry.make_valid()
        out[k] = g
        g.to_file(_CACHE, layer=k, driver="GPKG")
    return out


def build_lookup(coords: pd.DataFrame, b: dict[str, gpd.GeoDataFrame]) -> pd.DataFrame:
    """coords: DataFrame[lat, lon] (rounded, unique) -> adds uf, biome, is_rmc."""
    pts = gpd.GeoDataFrame(coords, geometry=gpd.points_from_xy(coords["lon"], coords["lat"]), crs=4326)
    out = coords.copy()
    s = gpd.sjoin(pts, b["states"][["uf", "geometry"]], how="left", predicate="within")
    out["uf"] = s[~s.index.duplicated()]["uf"].values
    bi = gpd.sjoin(pts, b["biomes"][["biome", "geometry"]], how="left", predicate="within")
    out["biome"] = bi[~bi.index.duplicated()]["biome"].values
    rm = gpd.sjoin(pts, b["rmc"][["geometry"]], how="left", predicate="within")
    out["is_rmc"] = rm[~rm.index.duplicated()]["index_right"].notna().values
    return out


def regions_table(b: dict[str, gpd.GeoDataFrame]) -> list[dict]:
    """Region catalogue for the web app. State parent = biome with largest area share."""
    states = b["states"].to_crs(5880)
    biomes = b["biomes"].to_crs(5880)
    inter = gpd.overlay(states[["uf", "geometry"]], biomes[["biome", "geometry"]], how="intersection")
    inter["a"] = inter.area
    parent = inter.sort_values("a").groupby("uf").tail(1).set_index("uf")["biome"].to_dict()
    regs = [{"id": "BR", "name": "Brazil", "kind": "country", "parent": None}]
    for code, name in sorted(C.BIOME_NAMES_EN.items(), key=lambda x: x[1]):
        regs.append({"id": f"BIOME_{code}", "name": name, "kind": "biome", "parent": "BR"})
    for _, r in b["states"].sort_values("name").iterrows():
        regs.append({"id": f"UF_{r.uf}", "name": r["name"], "kind": "state",
                     "parent": f"BIOME_{parent.get(r.uf, 'AMZ')}"})
    regs.append({"id": "RMC", "name": "Campinas Metro Area", "kind": "metro", "parent": "UF_SP"})
    return regs


if __name__ == "__main__":
    bb = load_boundaries()
    print(json.dumps(regions_table(bb), ensure_ascii=False)[:500])
