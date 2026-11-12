"""The spec's three replay acceptance tests, run end to end against Postgres:
synthetic units + predictions -> SQL freeze_snapshot -> replay through the
Watcher (manual clock, 2-minute ticks) -> assertions read back from the
irev_status / stall_events / flags tables."""

from __future__ import annotations

from collections import Counter
from datetime import timedelta

import psycopg
import pytest

from pos_watcher import db
from pos_watcher.adapters.replay import ReplayAdapter
from pos_watcher.adapters.synthetic import Scenario, scenario_demo, scenario_holdout, scenario_outage, scenario_stall
from pos_watcher.clock import ManualClock
from pos_watcher.runner import Watcher
from pos_watcher.setup import install_scenario

pytestmark = pytest.mark.db


def stall_rows(conn, election_id):
    return conn.execute("select started_at, ended_at, evidence from public.stall_events where election_id = %s "
                        "order by started_at", (election_id,)).fetchall()


async def replay(database_url: str, sc: Scenario, until_min: float, observe):
    """Install, freeze, then tick every 2 minutes from close to ``until_min``,
    calling ``observe(conn, t_min, report)`` after each tick."""
    conn = db.connect(database_url)
    install_scenario(conn, sc)
    db.reset_replay(conn, sc.election_id)
    model = db.load_model(conn, sc.election_id)
    assert model.snapshot_id and len(model.scores) == len(sc.units)
    clock = ManualClock(sc.polls_close_at)
    w = Watcher(conn, model, ReplayAdapter(sc.events, {u.pu_code for u in model.units}), clock)
    w.load_state()
    while True:
        report = await w.tick()
        observe(conn, report.t_min, report)
        if report.t_min >= until_min:
            break
        clock.advance(model.cfg.tick_s)
    return conn, w


async def test_a_system_stall(database_url):
    sc = scenario_stall()
    f0, f1 = sc.meta["freeze_start_min"], sc.meta["freeze_end_min"]
    seen = {"ticks_open": 0, "bad_while_open": 0, "first_open_t": None, "max_unresolved": 0}

    def observe(conn, t, report):
        open_rows = conn.execute("select 1 from public.stall_events where election_id = %s and ended_at is null",
                                 (sc.election_id,)).fetchone()
        if open_rows:
            seen["ticks_open"] += 1
            seen["first_open_t"] = seen["first_open_t"] or t
            classes = db.flag_classes(conn, sc.election_id)
            seen["max_unresolved"] = max(seen["max_unresolved"], len(classes))
            seen["bad_while_open"] += sum(1 for c in classes.values() if c != "HELD_SYSTEM_STALL")

    conn, w = await replay(database_url, sc, 240, observe)
    rows = stall_rows(conn, sc.election_id)
    started = (rows[0]["started_at"] - sc.polls_close_at).total_seconds() / 60
    ended = (rows[0]["ended_at"] - sc.polls_close_at).total_seconds() / 60
    print(f"\n[a] freeze {f0:.0f}-{f1:.0f} min; stall opened at {started:.0f} min "
          f"({started - f0:.0f} min after freeze), closed at {ended:.0f} min; {len(rows)} stall event(s); "
          f"{seen['ticks_open']} ticks open with up to {seen['max_unresolved']} pending units, "
          f"non-HELD unresolved flags while open: {seen['bad_while_open']}; "
          f"evidence={rows[0]['evidence']}")
    assert len(rows) == 1
    assert 0 <= started - f0 <= 25
    assert f1 <= ended <= f1 + 10
    assert seen["bad_while_open"] == 0 and seen["max_unresolved"] > 100
    # Public view shows them as held, never a class name.
    buckets = Counter(r["bucket"] for r in conn.execute(
        "select bucket from public.public_unit_status where election_id = %s", (sc.election_id,)))
    assert set(buckets) <= {"held_system_stall", "needs_review", "network_failure_plausible", "not_enough_tests"}
    conn.close()


async def test_b_weak_cluster_reads_as_network(database_url):
    sc = scenario_outage()
    cluster = set(sc.meta["cluster"])
    ever = Counter()
    final = {}

    def observe(conn, t, report):
        classes = db.flag_classes(conn, sc.election_id)
        for pu in cluster & set(classes):
            ever[classes[pu]] += 1
        if t == 200:
            final.update({pu: classes.get(pu) for pu in cluster})

    conn, _ = await replay(database_url, sc, 200, observe)
    stalls = stall_rows(conn, sc.election_id)
    sample = conn.execute("select evidence from public.flags where election_id = %s and pu_code = %s",
                          (sc.election_id, sorted(cluster)[0])).fetchone()["evidence"]
    print(f"\n[b] cluster of {len(cluster)} weak units dark until {sc.meta['cluster_up_min']:.0f} min; "
          f"classes at 200 min: {dict(Counter(final.values()))}; class-ticks over the night: {dict(ever)}; "
          f"stall events: {len(stalls)}; sample p_network={sample['p_network']} p_other={sample['p_other']} "
          f"m={sample['neighbours_uploaded']} s_t={sample['s_t']}")
    assert all(c == "PLAUSIBLE_NETWORK" for c in final.values()) and len(final) == len(cluster)
    assert ever["UNEXPLAINED_DELAY"] == 0
    assert stalls == []
    conn.close()


async def test_c_strong_holdouts_flagged(database_url):
    sc = scenario_holdout()
    held = set(sc.meta["held"])
    rest = {u.pu_code for u in sc.units} - held
    ever_unexplained: set[str] = set()
    snap = {}

    def observe(conn, t, report):
        classes = db.flag_classes(conn, sc.election_id)
        ever_unexplained.update(pu for pu, c in classes.items() if c == "UNEXPLAINED_DELAY")
        if t == 178:  # last tick before the held units upload (185-210 min)
            snap.update(classes)

    conn, w = await replay(database_url, sc, 240, observe)
    held_flagged = sum(1 for pu in held if snap.get(pu) == "UNEXPLAINED_DELAY")
    rest_now = sum(1 for pu in rest if snap.get(pu) == "UNEXPLAINED_DELAY")
    rest_ever = len(ever_unexplained & rest)
    stalls = stall_rows(conn, sc.election_id)
    resolved = conn.execute("select count(*) as n from public.flags where election_id = %s and pu_code = any(%s) "
                            "and resolved_at is not null", (sc.election_id, list(held))).fetchone()["n"]
    print(f"\n[c] {len(sc.units)} units, {len(held)} strong units held to 185-210 min. At 178 min: "
          f"{held_flagged}/{len(held)} held flagged UNEXPLAINED_DELAY; {rest_now}/{len(rest)} others "
          f"UNEXPLAINED ({100 * rest_now / len(rest):.1f}%); others ever UNEXPLAINED during the night: "
          f"{rest_ever} ({100 * rest_ever / len(rest):.1f}%); classes at 178: {dict(Counter(snap.values()))}; "
          f"stall events: {len(stalls)}; held flags resolved after upload: {resolved}/{len(held)}")
    assert held_flagged >= 18
    assert rest_now < 0.02 * len(rest)
    assert rest_ever < 0.02 * len(rest)
    assert stalls == []
    assert resolved == len(held)
    conn.close()


# --- flag lifecycle and data rules ------------------------------------------------

async def test_reviewed_flags_are_kept_and_frozen(database_url):
    sc = scenario_demo()
    dark = sc.meta["dark_unit"]
    conn, w = await replay(database_url, sc, 200, lambda *a: None)
    flag = conn.execute("select * from public.flags where election_id = %s and pu_code = %s",
                        (sc.election_id, dark)).fetchone()
    assert flag["class"] == "UNEXPLAINED_DELAY" and flag["resolved_at"] is None
    ev = flag["evidence"]
    assert ev["snapshot_sha256"] and ev["neighbours_uploaded"] >= 3 and ev["measured"]
    assert all(n["shared"] == "ward" for n in ev["neighbours"])

    # A reviewer marks it explained (as the API would, with a JWT user).
    uid = conn.execute("insert into auth.users (id) values (gen_random_uuid()) returning id").fetchone()["id"]
    org = conn.execute("select id from public.organisations where accredited limit 1").fetchone()["id"]
    try:
        conn.execute("insert into public.user_roles (user_id, org_id, role) values (%s, %s, 'reviewer')", (uid, org))
    except psycopg.Error:
        pass
    conn.execute("insert into public.flag_reviews (flag_id, reviewer_id, decision, note) "
                 "values (%s, %s, 'explained', 'Generator fault reported by observers')", (flag["id"], uid))
    before = conn.execute("select class, evidence, updated_at from public.flags where id = %s",
                          (flag["id"],)).fetchone()
    for _ in range(5):
        w.clock.advance(120)
        await w.tick()
    after = conn.execute("select class, evidence, updated_at, review_status from public.flags where id = %s",
                         (flag["id"],)).fetchone()
    assert after["review_status"] == "explained"
    assert (after["class"], after["evidence"], after["updated_at"]) == \
        (before["class"], before["evidence"], before["updated_at"])

    # Replay restart clears unreviewed flags, stalls and irev_status, but keeps the reviewed flag.
    cleared = db.reset_replay(conn, sc.election_id)
    assert cleared["flags"] > 0 and cleared["irev_status"] == len(sc.units)
    left = conn.execute("select pu_code from public.flags where election_id = %s", (sc.election_id,)).fetchall()
    assert [r["pu_code"] for r in left] == [dark]
    conn.close()


async def test_first_seen_is_set_once_and_non_replay_is_protected(database_url):
    conn = db.connect(database_url)
    sc = scenario_outage()
    install_scenario(conn, sc)
    db.reset_replay(conn, sc.election_id)
    model = db.load_model(conn, sc.election_id)
    from pos_watcher.adapters import UploadEvent
    pu = sc.units[0].pu_code
    t1 = sc.polls_close_at + timedelta(minutes=50)
    db.ensure_irev_rows(conn, sc.election_id, [u.pu_code for u in model.units], t1)
    assert len(db.record_events(conn, sc.election_id, [UploadEvent(pu, "uploaded", t1)], t1)) == 1
    assert db.record_events(conn, sc.election_id, [UploadEvent(pu, "uploaded", t1 + timedelta(minutes=9))],
                            t1) == []
    row = conn.execute("select state::text, first_seen_at from public.irev_status where election_id = %s "
                       "and pu_code = %s", (sc.election_id, pu)).fetchone()
    assert row["state"] == "uploaded" and row["first_seen_at"] == t1
    # The columns are times and states only: no place for result content.
    cols = {r["column_name"] for r in conn.execute(
        "select column_name from information_schema.columns where table_name = 'irev_status'")}
    assert cols == {"election_id", "pu_code", "state", "first_seen_at", "fetched_at", "page_hash"}

    conn.execute("insert into public.elections (id, name, election_date, state_codes, polls_close_at) "
                 "values ('real-like', 'not a replay', '2027-02-20', '{97}', now())")
    with pytest.raises(db.Forbidden):
        db.reset_replay(conn, "real-like")
    conn.close()


async def test_serving_cell_neighbours_loaded_from_accepted_tests(database_url):
    """Two units in different wards that share a registered serving cell in
    accepted tests become neighbours ('cell')."""
    conn = db.connect(database_url)
    sc = scenario_outage()
    install_scenario(conn, sc)
    a, b = "97-01-01-001", "97-01-02-001"
    dev = conn.execute("insert into public.devices (pubkey) values ('test-key-cell') returning id").fetchone()["id"]
    for i, pu in enumerate((a, b)):
        t = conn.execute(
            """insert into public.tests (device_id, pu_code, nonce, captured_at, received_at, local_date, is_evening,
                                         fix, acc_m, mock, geohash7, app_version, payload_sha256, signature,
                                         status, trust)
               values (%s, %s, null, now(), now(), current_date, true,
                       'SRID=4326;POINT(4.6 8.5)', 10, false, 's1abcde', '1.0.0', %s, 'sig', 'accepted', 0.5)
               returning id""", (dev, pu, bytes([i]) * 32)).fetchone()["id"]
        conn.execute("insert into public.test_sims (test_id, sim_slot, mcc, mnc, upload_ok) "
                     "values (%s, 0, 621, 30, true)", (t,))
        conn.execute("insert into public.test_cells (test_id, sim_slot, reg, radio, mcc, mnc, area, cid) "
                     "values (%s, 0, true, 'LTE', 621, 30, 9701, 1)", (t,))
    model = db.load_model(conn, sc.election_id)
    assert model.neighbourhoods[a][b] == "cell" and model.neighbourhoods[b][a] == "cell"
    assert model.units_by_code[a].cells == frozenset({("LTE", 621, 30, 9701, 1)})
    conn.close()
