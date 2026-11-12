"""Parsers and Postgres loaders for the public sources (used by data/*.py).

Licences (spec: "Data sources and licences"):
  OpenCellID            CC BY-SA 4.0: attribute OpenCellID; derived tower tables are share-alike.
  Ookla open data       CC BY-NC-SA 4.0: non-commercial use only, attribute Ookla, share-alike.
  GRID3 settlements     CC BY-SA 4.0 (CIESIN / GRID3).
  WorldPop population   CC BY 4.0.
  Copernicus DEM GLO-30 free licence, attribution "produced using Copernicus WorldDEM-30
                        (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018,
                        provided under COPERNICUS by the European Union and ESA".
  INEC PU locator / CredibleVoteNG  public lists; keep their attribution with any republication.
"""

from __future__ import annotations

import gzip
import io
import re
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C
from .geo import lnglat_to_tile, tile_to_quadkey

NIGERIA_BBOX = (2.67, 4.27, 14.68, 13.89)  # west, south, east, north

# --- polling units -----------------------------------------------------------

_PU_RE = re.compile(r"^\D*(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,3})\D*$")


def pad_pu_code(state, lga, ward, unit) -> str:
    """Zero-pad to the polling_units format SS-LL-WW-UUU."""
    s, l, w, u = (int(str(x).strip()) for x in (state, lga, ward, unit))
    if not (0 < s < 100 and 0 <= l < 100 and 0 <= w < 100 and 0 <= u < 1000):
        raise ValueError(f"PU code part out of range: {state}/{lga}/{ward}/{unit}")
    return f"{s:02d}-{l:02d}-{w:02d}-{u:03d}"


def parse_pu_code(code: str) -> str:
    """'24/5/8/5', '24-05-08-005', '24.05.08.005' or '24 05 08 005' -> '24-05-08-005'."""
    m = _PU_RE.match(str(code).strip())
    if not m:
        raise ValueError(f"unrecognised PU code {code!r}")
    return pad_pu_code(*m.groups())


def _col(df: pd.DataFrame, *candidates: str) -> str | None:
    norm = {re.sub(r"[^a-z0-9]", "", c.lower()): c for c in df.columns}
    for cand in candidates:
        k = re.sub(r"[^a-z0-9]", "", cand.lower())
        if k in norm:
            return norm[k]
    return None


def read_pu_list(path: str | Path, source: str) -> pd.DataFrame:
    """Read an INEC or CredibleVoteNG PU list (CSV) into polling_units rows.

    Accepts one code column (pu_code / delimitation / code) or separate
    state/lga/ward/unit code columns; name columns are matched loosely."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    code_col = _col(df, "pu_code", "delimitation", "polling_unit_code", "code", "pucode")
    if code_col:
        codes = df[code_col].map(parse_pu_code)
    else:
        parts = [_col(df, *c) for c in (("state_code", "statecode", "state_id"), ("lga_code", "lgacode", "lga_id"),
                                       ("ward_code", "wardcode", "ward_id", "registration_area_code"),
                                       ("unit_code", "pu_number", "unitcode", "pu_id"))]
        if None in parts:
            raise ValueError(f"{path}: need a PU code column or state/lga/ward/unit code columns; got {list(df.columns)}")
        codes = [pad_pu_code(*r) for r in df[parts].itertuples(index=False)]
    out = pd.DataFrame({"pu_code": codes})
    for key, cands in {"state": ("state", "state_name"), "lga": ("lga", "lga_name", "local_government"),
                       "ward": ("ward", "ward_name", "registration_area"),
                       "name": ("name", "pu_name", "polling_unit", "polling_unit_name"),
                       "location_desc": ("location", "description", "remark", "remarks")}.items():
        c = _col(df, *cands)
        out[key] = df[c].str.strip() if c else ""
    lat_c, lng_c = _col(df, "lat", "latitude", "y"), _col(df, "lng", "lon", "long", "longitude", "x")
    lat = pd.to_numeric(df[lat_c], errors="coerce") if lat_c else pd.Series(np.nan, index=df.index)
    lng = pd.to_numeric(df[lng_c], errors="coerce") if lng_c else pd.Series(np.nan, index=df.index)
    w, s, e, n = NIGERIA_BBOX
    ok = lat.between(s, n) & lng.between(w, e)
    out["lat"] = lat.where(ok)
    out["lng"] = lng.where(ok)
    out["geom_source"] = pd.Series(source, index=df.index, dtype=object).where(ok, None)
    out["geom_conf"] = np.where(ok, 1.0 if source == "inec" else 0.8, np.nan)
    for c in ("state", "lga", "ward", "name"):
        out[c] = out[c].replace("", "unknown")
    return out.drop_duplicates("pu_code", keep="first")


def upsert_pus(conn, pus: pd.DataFrame) -> int:
    """Insert or update units. A point is set when the unit has none, or a
    crowd point, or a CredibleVoteNG point being replaced by an INEC one."""
    sql = """
        insert into public.polling_units (pu_code, state, lga, ward, name, location_desc, geom, geom_source, geom_conf)
        values (%(pu_code)s, %(state)s, %(lga)s, %(ward)s, %(name)s, nullif(%(location_desc)s, ''),
                case when %(lat)s::float8 is null then null else
                  extensions.st_setsrid(extensions.st_makepoint(%(lng)s::float8, %(lat)s::float8), 4326)::extensions.geography end,
                %(geom_source)s::public.geom_source, %(geom_conf)s::numeric)
        on conflict (pu_code) do update set
          state = excluded.state, lga = excluded.lga, ward = excluded.ward, name = excluded.name,
          location_desc = coalesce(excluded.location_desc, polling_units.location_desc),
          geom = case when excluded.geom is not null and (polling_units.geom is null
                        or polling_units.geom_source = 'crowd'
                        or (polling_units.geom_source = 'crediblevote' and excluded.geom_source = 'inec'))
                      then excluded.geom else polling_units.geom end,
          geom_source = case when excluded.geom is not null and (polling_units.geom is null
                        or polling_units.geom_source = 'crowd'
                        or (polling_units.geom_source = 'crediblevote' and excluded.geom_source = 'inec'))
                      then excluded.geom_source else polling_units.geom_source end,
          geom_conf = case when excluded.geom is not null and (polling_units.geom is null
                        or polling_units.geom_source = 'crowd'
                        or (polling_units.geom_source = 'crediblevote' and excluded.geom_source = 'inec'))
                      then excluded.geom_conf else polling_units.geom_conf end,
          updated_at = now()"""
    recs = pus.replace({np.nan: None}).to_dict("records")
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany(sql, recs)
    return len(recs)


# --- OpenCellID ----------------------------------------------------------------

OCID_COLUMNS = ["radio", "mcc", "net", "area", "cell", "unit", "lon", "lat", "range", "samples",
                "changeable", "created", "updated", "averageSignal"]


def read_opencellid(source, mcc: int = C.MCC_NIGERIA, chunksize: int = 1_000_000) -> pd.DataFrame:
    """Parse an OpenCellID CSV (full dump, per-MCC file or getInArea output;
    with or without header; optionally gzipped) in chunks, keeping one MCC."""
    def opener():
        if isinstance(source, Path) or (isinstance(source, str) and "\n" not in source and Path(source).exists()):
            p = Path(source)
            return gzip.open(p, "rt", newline="") if p.suffix == ".gz" else open(p, newline="")
        return io.StringIO(str(source))

    with opener() as fh:
        first = fh.readline()
    header = first.strip().lower().startswith("radio")
    kw = {"header": 0} if header else {"header": None, "names": OCID_COLUMNS}
    parts = []
    with opener() as fh:
        for chunk in pd.read_csv(fh, dtype=str, chunksize=chunksize, **kw):
            chunk.columns = [{"cellid": "cell", "lng": "lon", "mnc": "net", "lac": "area", "tac": "area"}
                             .get(c.strip().lower(), c.strip()) for c in chunk.columns]
            parts.append(chunk[pd.to_numeric(chunk["mcc"], errors="coerce") == mcc])
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=OCID_COLUMNS)
    out = pd.DataFrame({
        "radio": df["radio"].str.strip().str.upper().replace({"WCDMA": "UMTS"}),
        "mcc": mcc,
        "mnc": pd.to_numeric(df["net"], errors="coerce"),
        "area": pd.to_numeric(df["area"], errors="coerce"),
        "cid": pd.to_numeric(df["cell"], errors="coerce"),
        "lng": pd.to_numeric(df["lon"], errors="coerce"),
        "lat": pd.to_numeric(df["lat"], errors="coerce"),
        "range_m": pd.to_numeric(df["range"], errors="coerce"),
        "ocid_samples": pd.to_numeric(df["samples"], errors="coerce").fillna(0) if "samples" in df else 0,
    })
    out = out[out["radio"].isin(["GSM", "UMTS", "LTE", "NR", "CDMA"])]
    out = out.dropna(subset=["mnc", "area", "cid"])
    return out.astype({"mnc": int, "area": int, "cid": "int64", "ocid_samples": int}).reset_index(drop=True)


def upsert_cells(conn, cells: pd.DataFrame) -> int:
    sql = """
        insert into public.cells (radio, mcc, mnc, area, cid, geom, range_m, ocid_samples)
        values (%s::public.radio_type, %s, %s, %s, %s,
                case when %s::float8 is null then null else
                  extensions.st_setsrid(extensions.st_makepoint(%s::float8, %s::float8), 4326)::extensions.geography end,
                %s, %s)
        on conflict (radio, mcc, mnc, area, cid) do update set
          geom = coalesce(excluded.geom, cells.geom), range_m = coalesce(excluded.range_m, cells.range_m),
          ocid_samples = excluded.ocid_samples, updated_at = now()"""
    rows = []
    for r in cells.itertuples(index=False):
        lat = None if pd.isna(r.lat) else float(r.lat)
        lng = None if pd.isna(r.lng) else float(r.lng)
        rng = None if pd.isna(r.range_m) else int(r.range_m)
        rows.append((r.radio, int(r.mcc), int(r.mnc), int(r.area), int(r.cid), lat, lng, lat, rng, int(r.ocid_samples)))
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany(sql, rows)
    return len(rows)


# --- Ookla -----------------------------------------------------------------------

def quadkey_prefixes(bbox=NIGERIA_BBOX, zoom: int = 8) -> list[str]:
    """Quadkeys at `zoom` covering bbox; zoom-16 tile quadkeys start with one of them."""
    w, s, e, n = bbox
    x0, y0 = lnglat_to_tile(w, n, zoom)
    x1, y1 = lnglat_to_tile(e, s, zoom)
    return [tile_to_quadkey(int(x), int(y), zoom) for x in range(int(x0), int(x1) + 1)
            for y in range(int(y0), int(y1) + 1)]


# --- GRID3 settlement extents --------------------------------------------------------

def settlements_from_gpkg(path: str | Path, layer: str | None = None) -> pd.DataFrame:
    """Settlement extents (GeoPackage) -> centroid, type, area (m^2), population if present."""
    import pyogrio
    import shapely
    from rasterio.crs import CRS
    from rasterio.warp import transform

    meta, _, geom, fields = pyogrio.raw.read(str(path), layer=layer)
    cols = {name.lower(): i for i, name in enumerate(meta["fields"])}
    tcol = next((cols[c] for c in ("type", "settlement_type", "set_type", "class") if c in cols), None)
    pcol = next((cols[c] for c in ("population", "pop", "pop_un_adj", "pop_est", "population_est") if c in cols), None)
    if tcol is None:
        raise ValueError(f"{path}: no settlement type column among {meta['fields']}")
    g = shapely.from_wkb(geom)
    cen = shapely.centroid(g)
    x, y = shapely.get_x(cen), shapely.get_y(cen)
    crs = CRS.from_user_input(meta["crs"]) if meta.get("crs") else CRS.from_epsg(4326)
    if crs.is_geographic:
        lat = y
        lng = x
        area = shapely.area(g) * (np.pi / 180 * 6_371_008.8) ** 2 * np.cos(np.radians(lat))
    else:
        area = shapely.area(g)
        lng, lat = (np.asarray(v) for v in transform(crs, "EPSG:4326", list(x), list(y)))
    out = pd.DataFrame({"lat": lat, "lng": lng, "type": fields[tcol].astype(str), "area_m2": area})
    if pcol is not None:
        out["population"] = pd.to_numeric(pd.Series(fields[pcol]), errors="coerce")
    return out
