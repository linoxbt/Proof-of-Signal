"""Database side of the model: read units, towers and tests; write features,
model versions and predictions; re-weight outliers; freeze snapshots.

Connects with DATABASE_URL as a role that bypasses RLS (contracts/api.md, Auth).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from . import config as C
from .features import add_day_and_context, compute_features, feature_columns, to_vectors
from .model import artefact_sha256, load_artefact, predict, save_artefact, train
from .outliers import flag_outliers
from .raster import Raster

log = logging.getLogger(__name__)

DEM_MARGIN_DEG = 0.45  # towers up to ~50 km away still get a terrain profile
POP_MARGIN_DEG = 0.03


def connect(url: str | None = None) -> psycopg.Connection:
    url = url or os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set (or pass --database-url)")
    # Autocommit: reads are standalone; every write happens inside conn.transaction().
    # client_encoding: dev clusters made by initdb without a locale are SQL_ASCII,
    # where psycopg would otherwise return text as bytes.
    return psycopg.connect(url, autocommit=True, client_encoding="UTF8")


def _df(conn, sql: str, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


# --- readers -----------------------------------------------------------------

def load_pus(conn) -> pd.DataFrame:
    """Units with coordinates. Units without a point take the centroid of
    their ward's pointed units (else their LGA's), flagged loc_imputed."""
    pus = _df(conn, """
        select pu_code, state_code, lga_code, ward_code,
               extensions.st_y(geom::extensions.geometry) as lat,
               extensions.st_x(geom::extensions.geometry) as lng
        from public.polling_units""")
    if pus.empty:
        return pus.assign(loc_imputed=False)
    pus[["lat", "lng"]] = pus[["lat", "lng"]].astype(float)
    pus["loc_imputed"] = pus["lat"].isna()
    for keys in (["state_code", "lga_code", "ward_code"], ["state_code", "lga_code"]):
        cen = pus.dropna(subset=["lat"]).groupby(keys)[["lat", "lng"]].mean()
        miss = pus["lat"].isna()
        if miss.any() and len(cen):
            fill = pus.loc[miss, keys].merge(cen, left_on=keys, right_index=True, how="left")
            pus.loc[miss, "lat"] = fill["lat"].to_numpy()
            pus.loc[miss, "lng"] = fill["lng"].to_numpy()
    n_none = int(pus["lat"].isna().sum())
    if n_none:
        log.warning("%d units have no point and no pointed unit in their ward or LGA: no features", n_none)
    return pus.dropna(subset=["lat"]).reset_index(drop=True)


def load_cells(conn) -> pd.DataFrame:
    c = _df(conn, """
        select radio::text as radio, mnc,
               extensions.st_y(geom::extensions.geometry) as lat,
               extensions.st_x(geom::extensions.geometry) as lng, range_m
        from public.cells where mcc = %s and geom is not null""", (C.MCC_NIGERIA,))
    return c.astype({"lat": float, "lng": float}) if len(c) else c


def load_carriers(conn) -> list[int]:
    return [int(r[0]) for r in conn.execute("select mnc from public.carriers where mcc = %s order by mnc",
                                            (C.MCC_NIGERIA,)).fetchall()]


def load_labels(conn) -> pd.DataFrame:
    """One row per (test, SIM): accepted tests in the 17:00-23:59 WAT window."""
    df = _df(conn, """
        select t.id::text as test_id, t.pu_code, s.mnc::int as mnc, s.success, t.trust::float8 as trust,
               t.device_id::text as device_id, t.local_date, s.total_ms
        from public.tests t join public.test_sims s on s.test_id = t.id
        where t.status = 'accepted' and t.is_evening and s.mcc = %s""", (C.MCC_NIGERIA,))
    if len(df):
        df["success"] = df["success"].astype(bool)
        df["trust"] = df["trust"].astype(float)
    return df


def load_day_features(conn) -> pd.DataFrame:
    """Daytime accepted tests per (unit, carrier): count and trust-weighted success rate."""
    return _df(conn, """
        select t.pu_code, s.mnc::int as mnc, count(*)::float8 as day_n,
               (sum(t.trust) filter (where s.success) / nullif(sum(t.trust), 0))::float8 as day_rate
        from public.tests t join public.test_sims s on s.test_id = t.id
        where t.status = 'accepted' and not t.is_evening and s.mcc = %s
        group by t.pu_code, s.mnc""", (C.MCC_NIGERIA,))


def load_evidence(conn) -> pd.DataFrame:
    df = _df(conn, """
        select pu_code, mnc::int as mnc, n_tests::int, n_devices::int, n_evenings::int,
               w_success::float8, w_failure::float8, measured
        from public.pu_carrier_evidence where mcc = %s""", (C.MCC_NIGERIA,))
    if len(df):
        tot = df["w_success"] + df["w_failure"]
        df["rate"] = np.where(tot > 0, df["w_success"] / tot.where(tot > 0, 1), np.nan)
    else:
        df["rate"] = pd.Series(dtype=float)
    return df


def load_features(conn, feature_version: str) -> pd.DataFrame:
    df = _df(conn, """
        select f.pu_code, f.mnc::int as mnc, f.vector, pu.state_code::int as state_code
        from public.features f join public.polling_units pu on pu.pu_code = f.pu_code
        where f.mcc = %s and f.feature_version = %s""", (C.MCC_NIGERIA, feature_version))
    if df.empty:
        return df
    vec = pd.DataFrame(list(df["vector"])).astype(float)
    out = pd.concat([df.drop(columns=["vector"]), vec], axis=1)
    for c in out.columns:
        if c.startswith("is_state_"):
            out[c] = out[c].fillna(0.0)
    return out


# --- sources -------------------------------------------------------------------

def _read_table(path: Path) -> pd.DataFrame | None:
    if path.exists():
        return pd.read_parquet(path)
    csv = path.with_suffix(".csv")
    if csv.exists():
        return pd.read_csv(csv, dtype={"quadkey": str})
    return None


def load_sources(directory: Path) -> dict:
    """dem.tif|dem.vrt, population.tif, settlements.parquet, ookla_mobile.parquet (all optional)."""
    d = Path(directory)
    dem = next((p for p in (d / "dem.vrt", d / "dem.tif") if p.exists()), None)
    pop = d / "population.tif"
    src = {
        "dem_path": dem,
        "pop_path": pop if pop.exists() else None,
        "settlements": _read_table(d / "settlements.parquet"),
        "ookla": _read_table(d / "ookla_mobile.parquet"),
    }
    if src["ookla"] is not None:
        src["ookla"]["quadkey"] = src["ookla"]["quadkey"].astype(str)
    missing = [k for k, v in src.items() if v is None]
    if missing:
        log.warning("sources missing in %s: %s (those features will be null)", d, ", ".join(missing))
    return src


# --- features --------------------------------------------------------------------

def build_features(conn, sources_dir: Path | None = None, feature_version: str = C.FEATURE_VERSION) -> pd.DataFrame:
    pus = load_pus(conn)
    cells = load_cells(conn)
    carriers = load_carriers(conn)
    src = load_sources(sources_dir or C.sources_dir())
    parts = []
    for state, grp in pus.groupby("state_code"):
        w, s, e, n = grp["lng"].min(), grp["lat"].min(), grp["lng"].max(), grp["lat"].max()
        dem = pop = None
        if src["dem_path"]:
            dem = Raster.from_file(src["dem_path"], (w - DEM_MARGIN_DEG, s - DEM_MARGIN_DEG,
                                                     e + DEM_MARGIN_DEG, n + DEM_MARGIN_DEG))
        if src["pop_path"]:
            pop = Raster.from_file(src["pop_path"], (w - POP_MARGIN_DEG, s - POP_MARGIN_DEG,
                                                     e + POP_MARGIN_DEG, n + POP_MARGIN_DEG))
        log.info("state %02d: %d units", state, len(grp))
        parts.append(compute_features(grp, cells, carriers, dem=dem, population=pop,
                                      settlements=src["settlements"], ookla=src["ookla"]))
    f = pd.concat(parts, ignore_index=True)
    for c in f.columns:
        if c.startswith("is_state_"):
            f[c] = f[c].fillna(0.0)
    ev = load_evidence(conn)
    measured = ev[ev["measured"] & ev["rate"].notna()][["pu_code", "mnc", "rate"]]
    f = add_day_and_context(f, load_day_features(conn), measured)
    vectors = to_vectors(f)
    with conn.transaction():
        conn.execute("delete from public.features where feature_version = %s", (feature_version,))
        with conn.cursor().copy(
                "copy public.features (pu_code, mcc, mnc, feature_version, vector) from stdin") as cp:
            for pu, mnc, vec in zip(f["pu_code"], f["mnc"], vectors):
                cp.write_row((pu, C.MCC_NIGERIA, int(mnc), feature_version, Jsonb(vec)))
    log.info("wrote %d feature rows (%s)", len(f), feature_version)
    return f


# --- outliers --------------------------------------------------------------------

def reweight_outliers(conn) -> dict:
    """Apply (or undo) the 0.2 trust factor for upload-time outliers. Idempotent."""
    rows = _df(conn, """
        select t.id::text as test_id, t.pu_code, s.mnc::int as mnc, s.total_ms::float8 as total_ms
        from public.tests t join public.test_sims s on s.test_id = t.id
        where t.status = 'accepted' and s.total_ms is not null""")
    flagged = flag_outliers(rows) if len(rows) else set()
    current = {r[0] for r in conn.execute(
        "select id::text from public.tests where trust_pre_outlier is not null").fetchall()}
    new = sorted(flagged - current)
    restore = sorted(current - flagged)
    with conn.transaction():
        if new:
            conn.execute("""
                update public.tests
                   set trust_pre_outlier = trust,
                       trust = round(trust * %s::numeric, 3),
                       outlier_reweighted_at = now()
                 where id = any(%s::uuid[]) and status = 'accepted' and trust_pre_outlier is null""",
                         (C.OUTLIER_FACTOR, [uuid.UUID(x) for x in new]))
        if restore:
            conn.execute("""
                update public.tests
                   set trust = trust_pre_outlier, trust_pre_outlier = null, outlier_reweighted_at = null
                 where id = any(%s::uuid[])""", ([uuid.UUID(x) for x in restore],))
        if new or restore:
            conn.execute("""
                insert into public.audit_log (actor, action, entity, entity_id, detail)
                values (null, 'outlier_reweight', 'tests', null, %s)""",
                         (Jsonb({"flagged": len(new), "restored": len(restore), "total_outliers": len(flagged),
                                 "factor": C.OUTLIER_FACTOR, "rule": "|log t - median| > 3 x 1.4826 x MAD per unit-carrier"}),))
    return {"outliers": len(flagged), "newly_flagged": len(new), "restored": len(restore)}


# --- train / predict / freeze ----------------------------------------------------

def next_model_version(conn) -> str:
    day = datetime.now(timezone.utc).date().isoformat()
    n = conn.execute("select count(*) from public.model_versions where id like %s", (day + ".%",)).fetchone()[0]
    return f"{day}.{n + 1}"


def train_and_register(conn, feature_version: str = C.FEATURE_VERSION, artefact_root: Path | None = None,
                       extra_metrics=None) -> tuple[str, dict]:
    feats = load_features(conn, feature_version)
    if feats.empty:
        raise SystemExit(f"no features for version {feature_version}; run `pos-model features` first")
    labels = load_labels(conn)
    if labels.empty:
        raise SystemExit("no accepted evening tests to train on")
    res = train(feats, labels, feature_columns(feats))
    res.feature_version = feature_version
    if extra_metrics:
        res.metrics.update(extra_metrics(res))
    version = next_model_version(conn)
    uri, sha = save_artefact(res, Path(artefact_root or C.artefact_dir()) / version)
    with conn.transaction():
        conn.execute("""
            insert into public.model_versions (id, feature_version, metrics, artefact_uri, artefact_sha256)
            values (%s, %s, %s, %s, %s)""",
                     (version, feature_version, Jsonb(json.loads(json.dumps(res.metrics, default=_jsonable))), uri, sha))
    return version, res.metrics


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(type(o))


def _artefact_path(uri: str | None, version: str, artefact_root: Path | None) -> Path:
    if artefact_root is not None:
        return Path(artefact_root) / version
    if uri and uri.startswith("file:"):
        return Path(url2pathname(urlparse(uri).path))
    return C.artefact_dir() / version


def predict_and_publish(conn, model_version: str | None = None, artefact_root: Path | None = None,
                        make_current: bool = True) -> dict:
    row = conn.execute(
        "select id, artefact_uri, artefact_sha256 from public.model_versions "
        + ("where id = %s" if model_version else "order by trained_at desc limit 1"),
        (model_version,) if model_version else None).fetchone()
    if row is None:
        raise SystemExit("no such model version; run `pos-model train` first")
    version, uri, sha = row
    path = _artefact_path(uri, version, artefact_root)
    if sha and artefact_sha256(path) != sha:
        raise SystemExit(f"artefact for {version} at {path} does not match its recorded sha256")
    art = load_artefact(path)
    feats = load_features(conn, art.feature_version)
    out = predict(art, feats, load_evidence(conn))
    with conn.transaction():
        conn.execute("delete from public.predictions where model_version = %s", (version,))
        with conn.cursor().copy("""copy public.predictions (pu_code, mcc, mnc, model_version, p_model, p, p_lo, p_hi,
                                   n_tests, n_devices, n_evenings, measured) from stdin""") as cp:
            for r in out.itertuples(index=False):
                cp.write_row((r.pu_code, C.MCC_NIGERIA, int(r.mnc), version, f"{r.p_model:.4f}", f"{r.p:.4f}",
                              f"{r.p_lo:.4f}", f"{r.p_hi:.4f}", int(r.n_tests), int(r.n_devices),
                              int(r.n_evenings), bool(r.measured)))
        if make_current:
            conn.execute("update public.model_versions set is_current = false where is_current and id <> %s", (version,))
            conn.execute("update public.model_versions set is_current = true where id = %s", (version,))
    return {
        "model_version": version, "predictions": int(len(out)), "units": int(out["pu_code"].nunique()),
        "with_tests": int((out["n_tests"] > 0).sum()), "measured": int(out["measured"].sum()),
        "mean_p": float(out["p"].mean()), "mean_interval_width": float((out["p_hi"] - out["p_lo"]).mean()),
        "is_current": make_current,
    }


def freeze(conn, election_id: str, model_version: str | None = None) -> dict:
    if model_version is None:
        r = conn.execute("select id from public.model_versions where is_current").fetchone()
        if r is None:
            raise SystemExit("no current model version; run `pos-model predict` first")
        model_version = r[0]
    with conn.transaction():
        sid = conn.execute("select public.freeze_snapshot(%s, %s)", (election_id, model_version)).fetchone()[0]
    sha, rows, ok = conn.execute(
        "select encode(sha256, 'hex'), row_count, public.snapshot_verify(id) from public.snapshots where id = %s",
        (sid,)).fetchone()
    return {"snapshot_id": str(sid), "election_id": election_id, "model_version": model_version,
            "sha256": sha, "row_count": rows, "verified": ok}
