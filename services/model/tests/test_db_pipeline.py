"""End-to-end pipeline on a throwaway database with every migration and the seed.

Needs a running Postgres 16 + PostGIS server, e.g. `PGDEV_PORT=54332 scripts/db-dev.sh start`,
and POS_MODEL_TEST_DB_URL (or DATABASE_URL) pointing at it. A fresh database
`pos_model_test_<pid>` is created and dropped; the dev database is not touched.
"""

import os
import shutil
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg
import pytest

from pos_model import pipeline
from pos_model.config import REPO_ROOT
from pos_model.demo import run_demo

pytestmark = pytest.mark.db

PSQL = shutil.which("psql") or "/usr/lib/postgresql/16/bin/psql"


def _server_url():
    url = os.environ.get("POS_MODEL_TEST_DB_URL") or os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("set POS_MODEL_TEST_DB_URL (or DATABASE_URL) to a dev Postgres + PostGIS server")
    return url


def _with_db(url, name):
    u = urlparse(url)
    return urlunparse(u._replace(path="/" + name))


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    url = _server_url()
    admin = _with_db(url, "postgres")
    try:
        conn = psycopg.connect(admin, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as e:
        pytest.skip(f"database not reachable: {e}")
    if not Path(PSQL).exists():
        pytest.skip("psql not found")
    name = f"pos_model_test_{os.getpid()}"
    conn.execute(f"drop database if exists {name} with (force)")
    conn.execute(f"create database {name}")
    test_url = _with_db(url, name)
    psql = [PSQL, test_url, "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    stub = (REPO_ROOT / "supabase/tests/00_supabase_stub.sql").read_text()
    has_roles = conn.execute("select 1 from pg_roles where rolname = 'anon'").fetchone()
    if has_roles:
        stub = "\n".join(l for l in stub.splitlines() if not l.startswith("create role "))
    subprocess.run(psql, input=stub, text=True, check=True, capture_output=True)
    for f in sorted((REPO_ROOT / "supabase/migrations").glob("*.sql")) + [REPO_ROOT / "supabase/seed.sql"]:
        r = subprocess.run(psql + ["-f", str(f)], text=True, capture_output=True)
        assert r.returncode == 0, f"{f.name}: {r.stderr}"
    yield test_url, tmp_path_factory.mktemp("model")
    conn.execute(f"drop database if exists {name} with (force)")
    conn.close()


def test_demo_end_to_end(db):
    url, tmp = db
    conn = pipeline.connect(url)
    s = run_demo(conn, seed=3, n_pus=500, sources_dir=tmp / "sources", artefact_root=tmp / "models",
                 freeze_election="replay-demo")
    n_units = conn.execute("select count(*) from polling_units").fetchone()[0]
    assert n_units == 505  # 500 synthetic + 5 seed units (one has no point: ward centroid)
    assert s["features"]["rows"] == n_units * 4
    v = s["model_version"]
    assert conn.execute("select count(*) from predictions where model_version = %s", (v,)).fetchone()[0] == n_units * 4
    assert conn.execute("select id from model_versions where is_current").fetchall() == [(v,)]
    # Coverage views used by the API return every unit.
    assert conn.execute("select count(*) from coverage_best_carrier").fetchone()[0] == n_units
    assert conn.execute("select count(*) from coverage_best_carrier where p_best is null").fetchone()[0] == 0
    # Prediction counts agree with the evidence view; measured follows the rule.
    bad = conn.execute("""
        select count(*) from predictions p left join pu_carrier_evidence e using (pu_code, mcc, mnc)
        where p.model_version = %s and (p.n_tests <> coalesce(e.n_tests, 0) or p.measured <> coalesce(e.measured, false))
        """, (v,)).fetchone()[0]
    assert bad == 0
    m = conn.execute("select metrics from model_versions where id = %s", (v,)).fetchone()[0]
    assert m["synthetic"] is True and {"tower_distance_logistic", "ookla_tile_logistic"} <= set(m["baselines"])
    assert "99" in m["by_state"] and set(m["by_carrier"]) <= {"20", "30", "50", "60"}
    assert m["model"]["auc"] > max(b["auc"] for b in m["baselines"].values())
    # Freeze through the SQL function: snapshot verifies.
    assert s["freeze"]["verified"] and s["freeze"]["row_count"] == n_units * 4
    conn.close()


def test_reweight_is_idempotent_and_reversible(db):
    url, _ = db
    conn = pipeline.connect(url)
    before = conn.execute("select id, trust, trust_pre_outlier from tests order by id").fetchall()
    r = pipeline.reweight_outliers(conn)
    assert r["newly_flagged"] == 0 and r["restored"] == 0 and r["outliers"] > 0
    assert conn.execute("select id, trust, trust_pre_outlier from tests order by id").fetchall() == before
    flagged = conn.execute("select count(*) from tests where trust_pre_outlier is not null "
                           "and trust <> round(trust_pre_outlier * 0.2, 3)").fetchone()[0]
    assert flagged == 0
    # A stale flag on a normal test is undone on the next run.
    tid, trust = conn.execute("select id, trust from tests where trust_pre_outlier is null and status = 'accepted' "
                              "order by id limit 1").fetchone()
    conn.execute("update tests set trust_pre_outlier = trust, trust = round(trust * 0.2, 3), "
                 "outlier_reweighted_at = now() where id = %s", (tid,))
    r = pipeline.reweight_outliers(conn)
    assert r["restored"] == 1
    assert conn.execute("select trust, trust_pre_outlier from tests where id = %s", (tid,)).fetchone() == (trust, None)
    conn.close()


def test_retrain_moves_current_and_freeze_uses_it(db):
    url, tmp = db
    conn = pipeline.connect(url)
    v2, _ = pipeline.train_and_register(conn, artefact_root=tmp / "models")
    out = pipeline.predict_and_publish(conn, v2, tmp / "models")
    assert out["is_current"]
    assert conn.execute("select id from model_versions where is_current").fetchall() == [(v2,)]
    f = pipeline.freeze(conn, "replay-demo")
    assert f["model_version"] == v2 and f["verified"]
    # A tampered artefact is refused.
    (tmp / "models" / v2 / "artefact.json").write_text("{}")
    with pytest.raises(SystemExit):
        pipeline.predict_and_publish(conn, v2, tmp / "models")
    conn.close()


def test_cli_freeze_unknown_election_fails(db):
    url, _ = db
    from pos_model.cli import main

    with pytest.raises(psycopg.errors.RaiseException):
        main(["--database-url", url, "freeze", "--election", f"nope-{uuid.uuid4().hex[:6]}"])


def test_pu_import_point_precedence(db, tmp_path):
    from pos_model.loaders import read_pu_list, upsert_pus

    url, _ = db
    conn = pipeline.connect(url)
    cv = tmp_path / "cv.csv"
    cv.write_text("pu_code,state,lga,ward,name,lat,lng\n98/1/1/1,Test,L,W,Unit A,9.0,7.0\n98/1/1/2,Test,L,W,Unit B,,\n")
    upsert_pus(conn, read_pu_list(cv, "crediblevote"))
    inec = tmp_path / "inec.csv"
    inec.write_text("pu_code,state,lga,ward,name,lat,lng\n98-01-01-001,Test,L,W,Unit A,9.1,7.1\n"
                    "98-01-01-002,Test,L,W,Unit B,9.2,7.2\n")
    upsert_pus(conn, read_pu_list(inec, "inec"))
    upsert_pus(conn, read_pu_list(cv, "crediblevote"))  # must not overwrite INEC points
    rows = conn.execute("""select pu_code, geom_source::text, round(extensions.st_y(geom::extensions.geometry)::numeric, 1)
                           from polling_units where state_code = 98 order by 1""").fetchall()
    assert [(r[0], r[1], float(r[2])) for r in rows] == [("98-01-01-001", "inec", 9.1), ("98-01-01-002", "inec", 9.2)]
    conn.execute("delete from polling_units where state_code = 98")
    conn.close()
