import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from pipeline.regions import build_lookup


def test_lookup_aligns_by_index_not_position():
    states = gpd.GeoDataFrame({"uf": ["AA", "BB"]}, geometry=[box(0, 0, 1, 1), box(1, 0, 2, 1)], crs=4326)
    biomes = gpd.GeoDataFrame({"biome": ["X"]}, geometry=[box(0, 0, 2, 1)], crs=4326)
    rmc = gpd.GeoDataFrame({"name_muni": ["m"]}, geometry=[box(1.5, 0, 2, 1)], crs=4326)
    # Points listed right-to-left and with a non-default index, plus one outside everything.
    coords = pd.DataFrame({"lat": [0.5, 0.5, 0.5, 5.0], "lon": [1.75, 1.25, 0.5, 5.0]}, index=[10, 7, 3, 99])
    out = build_lookup(coords, {"states": states, "biomes": biomes, "rmc": rmc})
    assert out.loc[10, "uf"] == "BB" and out.loc[10, "is_rmc"]
    assert out.loc[7, "uf"] == "BB" and not out.loc[7, "is_rmc"]
    assert out.loc[3, "uf"] == "AA" and out.loc[3, "biome"] == "X"
    assert pd.isna(out.loc[99, "uf"]) and not out.loc[99, "is_rmc"]
