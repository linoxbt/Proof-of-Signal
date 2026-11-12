# Data

This folder holds download scripts and loaders only. Raw datasets never go in git: `data/raw/` and `data/cache/` are ignored. The spec's "Data sources and licences" table lists the sources and licences.

Run the scripts with the model service's virtualenv (`cd services/model && python3 -m venv .venv && .venv/bin/pip install -e '.[data,dev]'`):

| Script | Source | Licence | Output |
| --- | --- | --- | --- |
| `opencellid.py download mcc` / `download area` / `load FILE [--verify-carriers]` | OpenCellID, MCC 621 (key in `OPENCELLID_TOKEN`) | CC BY-SA 4.0 | `raw/opencellid/` → `public.cells` |
| `ookla.py download [--quarters 4]` / `build` | Ookla open data, mobile tiles (anonymous HTTPS, DuckDB httpfs) | CC BY-NC-SA 4.0, **non-commercial** | `raw/ookla/` → `cache/sources/ookla_mobile.parquet` |
| `grid3.py download` / `build` | GRID3 NGA Settlement Extents v3.1 (HDX); WorldPop NGA 2020 population | CC BY-SA 4.0; CC BY 4.0 | `cache/sources/settlements.parquet`, `population.tif` |
| `copernicus_dem.py [--bbox W S E N]` | Copernicus DEM GLO-30 (AWS open data) | Copernicus DEM licence (attribution) | `raw/dem/*.tif` → `cache/sources/dem.vrt` |
| `import_pus.py FILE --source inec\|crediblevote` | INEC PU locator / CredibleVoteNG lists (downloaded by hand) | Public; keep attribution | `public.polling_units` (codes zero-padded to `SS-LL-WW-UUU`) |

The two scripts that write to Postgres (`opencellid.py load` and `import_pus.py`) need `DATABASE_URL`. The other sources stay as files that `pos-model features --sources data/cache/sources` reads.

`pos-model demo` writes synthetic stand-ins for all of these to `data/cache/sources-synthetic/`.
