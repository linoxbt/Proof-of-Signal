"""`pos-model demo`: fill a development database end to end with the synthetic
world (state 99), then build features, re-weight outliers, train, predict and
optionally freeze. Never run against production: every row it writes is
synthetic and is marked (app_version 'synthetic-demo', devices with
integrity_level 'SYNTHETIC', model metrics "synthetic": true).
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C
from .metrics import score
from .pipeline import build_features, freeze, predict_and_publish, reweight_outliers, train_and_register
from .synth import CARRIERS, World, make_world

log = logging.getLogger(__name__)

SYNTH_APP_VERSION = "synthetic-demo"


def write_sources(world: World, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    world.dem.to_file(directory / "dem.tif")
    world.population.to_file(directory / "population.tif")
    world.settlements.to_parquet(directory / "settlements.parquet", index=False)
    world.ookla.to_parquet(directory / "ookla_mobile.parquet", index=False)
    (directory / "README.txt").write_text("Synthetic sources written by `pos-model demo`. Not real data.\n")


def write_world(conn, world: World) -> dict:
    """Insert units, cells, devices and tests. Units and cells are upserted
    (do nothing on conflict); tests are inserted only once per database."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany("""
                insert into public.polling_units (pu_code, state, lga, ward, name, geom, geom_source, geom_conf)
                values (%s, %s, %s, %s, %s,
                        extensions.st_setsrid(extensions.st_makepoint(%s, %s), 4326)::extensions.geography,
                        %s::public.geom_source, 1)
                on conflict (pu_code) do nothing""",
                [(r.pu_code, r.state, r.lga, r.ward, r.name, r.lng, r.lat, r.geom_source) for r in world.pus.itertuples()])
            cur.executemany("""
                insert into public.cells (radio, mcc, mnc, area, cid, geom, range_m, ocid_samples)
                values (%s::public.radio_type, %s, %s, %s, %s,
                        extensions.st_setsrid(extensions.st_makepoint(%s, %s), 4326)::extensions.geography, %s, %s)
                on conflict do nothing""",
                [(r.radio, r.mcc, r.mnc, r.area, r.cid, r.lng, r.lat, r.range_m, r.ocid_samples)
                 for r in world.cells.itertuples()])
    n_existing = conn.execute("select count(*) from public.tests where app_version = %s",
                              (SYNTH_APP_VERSION,)).fetchone()[0]
    if n_existing:
        log.info("synthetic tests already present (%d); not inserting again", n_existing)
        return {"tests_inserted": 0, "tests_existing": int(n_existing)}

    now = datetime.now(timezone.utc)
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany("""
                insert into public.devices (id, pubkey, integrity_level, reputation, app_version, status)
                values (%s, %s, 'SYNTHETIC', %s, %s, 'active') on conflict do nothing""",
                [(d.device_id, f"synthetic-demo:{d.device_id}", d.reputation, SYNTH_APP_VERSION)
                 for d in world.devices.itertuples()])
            with cur.copy("""copy public.tests (id, device_id, pu_code, nonce, captured_at, received_at, acc_m, mock,
                             dist_to_pu_m, geohash7, app_version, payload_sha256, signature, trust, status,
                             gps_purged_at) from stdin""") as cp:
                for t in world.tests.itertuples():
                    cp.write_row((t.test_id, t.device_id, t.pu_code, f"n_synth_{t.test_id}", t.captured_at,
                                  t.captured_at + timedelta(seconds=40), t.acc_m, False, t.dist_to_pu_m, t.geohash7,
                                  SYNTH_APP_VERSION, hashlib.sha256(t.test_id.encode()).digest(), "synthetic",
                                  f"{t.trust:.3f}", "accepted", now))
            with cur.copy("""copy public.test_sims (test_id, sim_slot, mcc, mnc, net_type, latency_ms, upload_ok,
                             upload_bytes, total_ms, http_status, err) from stdin""") as cp:
                for s in world.test_sims.itertuples():
                    total = None if pd.isna(s.total_ms) else int(s.total_ms)
                    cp.write_row((s.test_id, s.sim_slot, s.mcc, s.mnc, s.net_type, s.latency_ms, s.upload_ok,
                                  1_572_864 if s.upload_ok else None, total, 200 if s.upload_ok else None, s.err))
        # The insert trigger derives is_evening / local_date and applies the daily
        # cap; check it agrees with the generator so labels mean what we think.
        bad = conn.execute("""
            select count(*) from public.tests t
            join unnest(%s::uuid[], %s::bool[]) as g(id, ev) on g.id = t.id
            where t.is_evening <> g.ev or t.status <> 'accepted'""",
                           ([uuid.UUID(x) for x in world.tests["test_id"]], [bool(x) for x in world.tests["is_evening"]])).fetchone()[0]
        if bad:
            raise RuntimeError(f"{bad} synthetic tests disagree with the database's derived fields")
    return {"tests_inserted": int(len(world.tests)), "sims_inserted": int(len(world.test_sims))}


def run_demo(conn, seed: int = 7, n_pus: int = 1000, sources_dir: Path | None = None,
             artefact_root: Path | None = None, freeze_election: str | None = None) -> dict:
    sources_dir = Path(sources_dir or C.REPO_ROOT / "data" / "cache" / "sources-synthetic")
    world = make_world(seed=seed, n_pus=n_pus)
    write_sources(world, sources_dir)
    summary = {"world": {"units": int(len(world.pus)), "cells": int(len(world.cells)),
                         "tests": int(len(world.tests)), "evening_sims": int(len(world.labels())),
                         "ookla_tiles": int(len(world.ookla)), "sources_dir": str(sources_dir)}}
    summary["insert"] = write_world(conn, world)
    summary["outliers"] = reweight_outliers(conn)
    f = build_features(conn, sources_dir)
    summary["features"] = {"rows": int(len(f)), "units": int(f["pu_code"].nunique()), "carriers": list(CARRIERS)}

    truth = world.truth.set_index(["pu_code", "mnc"])["p_true"]

    def oracle(res):
        oof = res.oof
        keys = list(zip(oof["pu_code"], oof["mnc"].astype(int)))
        have = np.array([k in truth.index for k in keys])
        p_true = np.array([truth.get(k, np.nan) for k in keys])
        return {"synthetic": True,
                "synthetic_oracle_p_true": score(oof["y"][have], p_true[have]) if have.any() else None}

    version, metrics = train_and_register(conn, artefact_root=artefact_root, extra_metrics=oracle)
    summary["model_version"] = version
    summary["metrics"] = {k: metrics[k] for k in ("model", "baselines", "interval", "ece_ok", "synthetic_oracle_p_true")}
    summary["predict"] = predict_and_publish(conn, version, artefact_root)
    if freeze_election:
        summary["freeze"] = freeze(conn, freeze_election, version)
    return summary
