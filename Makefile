PY := .venv/bin/python

.PHONY: setup data nrt pipeline test web dev
setup:            ## Python env + web deps
	uv venv .venv --python 3.12 && uv pip install -p .venv -r requirements.lock -e ".[dev]"
	cd web && npm ci
data:             ## Download NASA FIRMS yearly CSVs for Brazil (~2.2 GB, resumable)
	$(PY) scripts/download.py
nrt:              ## Current-year data from the FIRMS API (needs FIRMS_MAP_KEY in .env)
	$(PY) scripts/fetch_nrt.py
pipeline:         ## Build monthly series, harmonize, validate, export web data
	$(PY) -m pipeline.build && $(PY) -m pipeline.export && $(PY) -m pipeline.grid && $(PY) -m pipeline.backtest
test:
	$(PY) -m pytest -q
web:              ## Production build of the site into web/dist
	cd web && npm run build
dev:
	cd web && npm run dev
