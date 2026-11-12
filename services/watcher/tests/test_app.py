import time

import pytest
from fastapi.testclient import TestClient

from pos_watcher import db
from pos_watcher.adapters.synthetic import scenario_demo
from pos_watcher.app import create_app
from pos_watcher.control import Controller, resolve_timeline
from pos_watcher.setup import install_scenario

TOKEN = "test-admin-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_healthz_and_auth_without_db():
    with TestClient(create_app(Controller("postgresql://unused"), admin_token=TOKEN)) as c:
        assert c.get("/healthz").json() == {"ok": True}
        r = c.get("/status")
        assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"
        assert c.get("/status", headers={"Authorization": "Bearer nope"}).status_code == 401
        assert c.get("/status", headers=AUTH).json()["mode"] == "idle"
        r = c.post("/replay/start", headers=AUTH, json={"election_id": "replay-demo", "timeline": "x", "speed": 500})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_body"
        r = c.post("/replay/start", headers=AUTH, json={"election_id": "replay-demo", "timeline": "../../etc/passwd"})
        assert r.status_code == 404


def test_empty_token_locks_everything():
    with TestClient(create_app(Controller("postgresql://unused"), admin_token="")) as c:
        assert c.get("/status", headers={"Authorization": "Bearer "}).status_code == 401


def test_resolve_timeline_by_name():
    assert resolve_timeline("replay-demo").name == "replay-demo.jsonl"
    with pytest.raises(FileNotFoundError):
        resolve_timeline("/etc/hostname")


@pytest.mark.db
def test_replay_start_status_stop(database_url):
    with db.connect(database_url) as conn:
        install_scenario(conn, scenario_demo())
        conn.execute("insert into public.elections (id, name, election_date, state_codes, polls_close_at) "
                     "values ('not-replay', 'x', '2027-01-01', '{99}', now()) on conflict do nothing")
    with TestClient(create_app(Controller(database_url), admin_token=TOKEN)) as c:
        r = c.post("/replay/start", headers=AUTH, json={"election_id": "not-replay", "timeline": "replay-demo"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden"
        r = c.post("/replay/start", headers=AUTH, json={"election_id": "nope", "timeline": "replay-demo"})
        assert r.status_code == 404
        r = c.post("/replay/start", headers=AUTH,
                   json={"election_id": "replay-demo", "timeline": "replay-demo", "speed": 60})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["events"] == 319 and body["skipped_unknown_units"] == 0
        deadline = time.time() + 10
        while time.time() < deadline:
            st = c.get("/status", headers=AUTH).json()
            if st["last_tick_at"] and st["sim_time"] > "2026-12-12T14:32":
                break
            time.sleep(0.2)
        assert st["mode"] == "replay" and st["election_id"] == "replay-demo" and st["speed"] == 60
        assert st["stall_active"] is False and st["last_tick_at"].startswith("2026-12-12T14:3")
        r = c.post("/replay/stop", headers=AUTH)
        assert r.json()["stopped"] is True and r.json()["status"]["mode"] == "idle"
    with db.connect(database_url) as conn:
        n = conn.execute("select count(*) as n from public.irev_status where election_id = 'replay-demo'").fetchone()
        assert n["n"] == 320
