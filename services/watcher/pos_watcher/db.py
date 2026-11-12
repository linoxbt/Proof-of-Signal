"""Postgres access (psycopg 3). The watcher connects with DATABASE_URL as a
role that bypasses RLS (contracts/api.md, Auth).

Reads: elections, snapshots (frozen config + hash), frozen_predictions for
the election's snapshot, polling_units, carriers, and registered serving
cells of accepted tests (for the 'same serving cell' neighbour rule).
It never reads ``predictions`` or ``coverage_*``.

Writes: irev_status (first-seen times only), stall_events, flags.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Mapping

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .adapters import UploadEvent
from .config import WatcherConfig
from .engine import CarrierScore, ElectionModel, OpenStall, TickOutcome, Unit, best_carrier


class NotFound(Exception):
    pass


class Forbidden(Exception):
    pass


def connect(url: str) -> psycopg.Connection:
    conn = psycopg.connect(url, autocommit=True, row_factory=dict_row)
    # A cluster created with SQL_ASCII would hand text back as bytes.
    conn.execute("set client_encoding to 'UTF8'")
    conn.execute("set timezone to 'UTC'")
    return conn


@dataclass(frozen=True)
class ElectionRow:
    id: str
    polls_close_at: datetime
    state_codes: list[int]
    snapshot_id: str | None
    is_replay: bool


def get_election(conn: psycopg.Connection, election_id: str) -> ElectionRow:
    r = conn.execute("select id, polls_close_at, state_codes, snapshot_id::text, is_replay "
                     "from public.elections where id = %s", (election_id,)).fetchone()
    if r is None:
        raise NotFound(f"unknown election {election_id}")
    return ElectionRow(r["id"], r["polls_close_at"], list(r["state_codes"]), r["snapshot_id"], r["is_replay"])


def load_model(conn: psycopg.Connection, election_id: str) -> ElectionModel:
    e = get_election(conn, election_id)
    if e.snapshot_id is None:
        raise NotFound(f"election {election_id} has no frozen snapshot; run freeze_snapshot first")
    snap = conn.execute("select config, encode(sha256, 'hex') as sha from public.snapshots where id = %s",
                        (e.snapshot_id,)).fetchone()
    cfg = WatcherConfig.from_frozen(snap["config"])

    cells: dict[str, set] = {}
    for r in conn.execute(
            """select distinct t.pu_code, tc.radio::text as radio, tc.mcc, tc.mnc, tc.area, tc.cid
                 from public.tests t
                 join public.test_cells tc on tc.test_id = t.id
                 join public.polling_units pu on pu.pu_code = t.pu_code
                where t.status = 'accepted' and tc.reg and tc.cid is not null and tc.area is not null
                  and tc.mcc is not null and tc.mnc is not null and pu.state_code = any(%s)""",
            (e.state_codes,)):
        cells.setdefault(r["pu_code"], set()).add((r["radio"], r["mcc"], r["mnc"], r["area"], r["cid"]))

    units = [Unit(r["pu_code"], r["name"], r["ward"], r["lga"], r["state_code"], r["lat"], r["lng"],
                  frozenset(cells.get(r["pu_code"], ())))
             for r in conn.execute(
                 """select pu_code, name, ward, lga, state_code,
                           extensions.st_y(geom::extensions.geometry) as lat,
                           extensions.st_x(geom::extensions.geometry) as lng
                      from public.polling_units where state_code = any(%s) order by pu_code""",
                 (e.state_codes,))]

    rows: dict[str, list[CarrierScore]] = {}
    for r in conn.execute(
            """select fp.pu_code, fp.mcc, fp.mnc, c.name as carrier, fp.p, fp.p_lo, fp.p_hi,
                      fp.n_tests, fp.n_devices, fp.n_evenings, fp.measured
                 from public.frozen_predictions fp
                 left join public.carriers c on c.mcc = fp.mcc and c.mnc = fp.mnc
                where fp.snapshot_id = %s""", (e.snapshot_id,)):
        rows.setdefault(r["pu_code"], []).append(CarrierScore(
            r["mcc"], r["mnc"], r["carrier"], float(r["p"]), float(r["p_lo"]), float(r["p_hi"]),
            r["n_tests"], r["n_devices"], r["n_evenings"], r["measured"]))
    scores = {pu: best_carrier(rs) for pu, rs in rows.items()}
    return ElectionModel(e.id, e.polls_close_at, e.snapshot_id, snap["sha"], cfg, units, scores)


# ---------------------------------------------------------------------------
# irev_status
# ---------------------------------------------------------------------------

def ensure_irev_rows(conn: psycopg.Connection, election_id: str, pu_codes: Iterable[str], at: datetime) -> None:
    conn.execute(
        """insert into public.irev_status (election_id, pu_code, state, fetched_at)
           select %s, unnest(%s::text[]), 'pending', %s
           on conflict (election_id, pu_code) do nothing""", (election_id, list(pu_codes), at))


def read_irev(conn: psycopg.Connection, election_id: str) -> tuple[dict[str, datetime], set[str]]:
    uploaded, cancelled = {}, set()
    for r in conn.execute("select pu_code, state::text, first_seen_at from public.irev_status "
                          "where election_id = %s and state <> 'pending'", (election_id,)):
        if r["state"] == "uploaded":
            uploaded[r["pu_code"]] = r["first_seen_at"]
        else:
            cancelled.add(r["pu_code"])
    return uploaded, cancelled


def record_events(conn: psycopg.Connection, election_id: str, events: Iterable[UploadEvent],
                  fetched_at: datetime) -> list[UploadEvent]:
    """First sighting wins: only a pending unit moves. Returns the events applied."""
    applied = []
    with conn.transaction():
        for ev in events:
            first_seen = ev.at if ev.kind == "uploaded" else None
            r = conn.execute(
                """insert into public.irev_status (election_id, pu_code, state, first_seen_at, fetched_at, page_hash)
                   values (%s, %s, %s, %s, %s, %s)
                   on conflict (election_id, pu_code) do update
                     set state = excluded.state, first_seen_at = excluded.first_seen_at,
                         fetched_at = excluded.fetched_at, page_hash = excluded.page_hash
                   where public.irev_status.state = 'pending'
                   returning pu_code""",
                (election_id, ev.pu_code, ev.kind, first_seen, fetched_at, ev.page_hash)).fetchone()
            if r is not None:
                applied.append(ev)
                # A flag stays after its unit uploads (or is cancelled); resolved_at records when.
                conn.execute("update public.flags set resolved_at = %s, updated_at = now() "
                             "where election_id = %s and pu_code = %s and resolved_at is null",
                             (ev.at, election_id, ev.pu_code))
    return applied


# ---------------------------------------------------------------------------
# stall_events
# ---------------------------------------------------------------------------

def read_open_stall(conn: psycopg.Connection, election_id: str) -> OpenStall | None:
    r = conn.execute("select id, started_at, evidence from public.stall_events "
                     "where election_id = %s and ended_at is null", (election_id,)).fetchone()
    if r is None:
        return None
    return OpenStall(r["id"], r["started_at"], float(r["evidence"].get("baseline_strong_rate", 0.0)))


def apply_stall(conn: psycopg.Connection, election_id: str, outcome: TickOutcome, now: datetime,
                open_stall: OpenStall | None) -> OpenStall | None:
    if outcome.stall_action == "open":
        ev = outcome.metrics.as_evidence() | {
            "baseline_strong_rate": round(outcome.metrics.strong_trailing_rate, 4),
            "minutes_since_close": int(outcome.t_min)}
        r = conn.execute("insert into public.stall_events (election_id, started_at, evidence) "
                         "values (%s, %s, %s) returning id", (election_id, now, Jsonb(ev))).fetchone()
        return OpenStall(r["id"], now, outcome.metrics.strong_trailing_rate)
    if outcome.stall_action == "close" and open_stall is not None:
        conn.execute("update public.stall_events set ended_at = %s, "
                     "evidence = evidence || jsonb_build_object('at_close', %s::jsonb) where id = %s",
                     (now, json.dumps(outcome.metrics.as_evidence()), open_stall.id))
        return None
    return open_stall


# ---------------------------------------------------------------------------
# flags
# ---------------------------------------------------------------------------

def read_flags(conn: psycopg.Connection, election_id: str) -> dict[str, dict]:
    return {r["pu_code"]: r for r in conn.execute(
        "select id, pu_code, class::text as class, review_status::text as review_status, resolved_at "
        "from public.flags where election_id = %s", (election_id,))}


def apply_flags(conn: psycopg.Connection, model: ElectionModel, outcome: TickOutcome) -> dict[str, int]:
    """Insert flags for newly classified pending units; update unreviewed ones
    (class, p_network, p_other, evidence). Reviewed flags are left alone."""
    existing = read_flags(conn, model.election_id)
    inserts, class_changes, refresh = [], [], []
    for pu, res in outcome.results.items():
        row = {"pu_code": pu, "class": res.flag_class, "p_network": round(res.p_network, 4),
               "p_other": round(res.p_other, 4), "evidence": res.evidence}
        cur = existing.get(pu)
        if cur is None:
            inserts.append(row)
        elif cur["review_status"] != "unreviewed" or cur["resolved_at"] is not None:
            continue
        elif cur["class"] != res.flag_class:
            class_changes.append(row)
        else:
            refresh.append(row)
    with conn.transaction():
        if inserts:
            conn.execute(
                """insert into public.flags (election_id, pu_code, snapshot_id, class, p_network, p_other, evidence)
                   select %s, x.pu_code, %s, x.class::public.flag_class, x.p_network, x.p_other, x.evidence
                     from jsonb_to_recordset(%s) as x(pu_code text, class text, p_network numeric,
                                                      p_other numeric, evidence jsonb)
                   on conflict (election_id, pu_code) do nothing""",
                (model.election_id, model.snapshot_id, Jsonb(inserts)))
        if class_changes:
            conn.execute(
                """update public.flags f
                      set class = x.class::public.flag_class, p_network = x.p_network, p_other = x.p_other,
                          evidence = x.evidence, updated_at = now()
                     from jsonb_to_recordset(%s) as x(pu_code text, class text, p_network numeric,
                                                      p_other numeric, evidence jsonb)
                    where f.election_id = %s and f.pu_code = x.pu_code
                      and f.review_status = 'unreviewed' and f.resolved_at is null""",
                (Jsonb(class_changes), model.election_id))
        if refresh:  # no `class` in the SET list, so the class-change audit trigger stays quiet
            conn.execute(
                """update public.flags f
                      set p_network = x.p_network, p_other = x.p_other, evidence = x.evidence, updated_at = now()
                     from jsonb_to_recordset(%s) as x(pu_code text, p_network numeric, p_other numeric,
                                                      evidence jsonb)
                    where f.election_id = %s and f.pu_code = x.pu_code
                      and f.review_status = 'unreviewed' and f.resolved_at is null""",
                (Jsonb(refresh), model.election_id))
    return {"inserted": len(inserts), "class_changed": len(class_changes), "refreshed": len(refresh)}


def reset_replay(conn: psycopg.Connection, election_id: str) -> dict[str, int]:
    """Clears a REPLAY election's irev_status, stall_events and unreviewed flags.
    Reviewed flags (and their reviews) are kept."""
    e = get_election(conn, election_id)
    if not e.is_replay:
        raise Forbidden(f"{election_id} is not a replay election")
    with conn.transaction():
        f = conn.execute("""delete from public.flags f
                             where f.election_id = %s and f.review_status = 'unreviewed'
                               and not exists (select 1 from public.flag_reviews r where r.flag_id = f.id)""",
                         (election_id,)).rowcount
        s = conn.execute("delete from public.stall_events where election_id = %s", (election_id,)).rowcount
        i = conn.execute("delete from public.irev_status where election_id = %s", (election_id,)).rowcount
    return {"flags": f, "stall_events": s, "irev_status": i}


def flag_classes(conn: psycopg.Connection, election_id: str, unresolved_only: bool = True) -> dict[str, str]:
    q = "select pu_code, class::text as class from public.flags where election_id = %s"
    if unresolved_only:
        q += " and resolved_at is null"
    return {r["pu_code"]: r["class"] for r in conn.execute(q, (election_id,))}
