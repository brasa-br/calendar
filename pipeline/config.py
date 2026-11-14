"""All pipeline parameters in one place."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "firms"
INTERIM = ROOT / "data" / "interim"
WEB_DATA = ROOT / "web" / "public" / "data"
DOCS = ROOT / "docs"

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
MODIS_YEARS = range(2000, 2026)
VIIRS_YEARS = range(2012, 2026)

# Series span
START_MONTH = "2000-11"
END_MONTH = "2025-12"

# Filters (spec §4.2)
KEEP_TYPES = (0,)                 # presumed vegetation fire
MODIS_CONF_LOW_MAX = 30           # MODIS confidence < 30 -> low
MODIS_CONF_HIGH_MIN = 80          # >= 80 -> high
KEEP_CONF = ("nominal", "high")

# Region assignment grid (degrees) for point->polygon lookup
LOOKUP_ROUND = 2                  # 0.01 deg
FIREDAY_CELL = 0.1                # robustness metric cell size
MAP_CELL = 0.25                   # stretch grid map

# Harmonization (spec §5)
OVERLAP_START = "2012-01"
OVERLAP_END = "2025-12"
TERRA_AQUA_FIT = ("2003-01", "2011-12")
AQUA_FULL_FROM = "2002-09"        # months before this are Terra-only/partial Aqua
MIN_TERRA_FOR_OWN_KTA = 200
MIN_VIIRS_FOR_OWN_MODEL = 1000
MIN_NONZERO_MODIS_MONTHS = 60
CV_FOLDS = ((("2012-01", "2018-12"), ("2019-01", "2025-12")),
            (("2019-01", "2025-12"), ("2012-01", "2018-12")))
PI_LEVEL = 0.90

BIOME_CODES = {
    "Amazônia": "AMZ", "Caatinga": "CAA", "Cerrado": "CER",
    "Mata Atlântica": "MAT", "Pampa": "PAM", "Pantanal": "PAN",
}
BIOME_NAMES_EN = {
    "AMZ": "Amazon", "CAA": "Caatinga", "CER": "Cerrado",
    "MAT": "Atlantic Forest", "PAM": "Pampa", "PAN": "Pantanal",
}
