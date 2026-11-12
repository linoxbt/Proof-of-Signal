"""Installs a synthetic scenario in a dev database: units, a synthetic model
version with predictions, a replay election, and a frozen snapshot made by the
SQL ``freeze_snapshot``. Refuses state codes that exist in Nigeria (01-37).

The synthetic model version is never marked ``is_current``, so it cannot
displace the model service's real current version.
"""

from __future__ import annotations

import psycopg
from psycopg.types.json import Jsonb

from .adapters.synthetic import Scenario


def install_scenario(conn: psycopg.Connection, sc: Scenario) -> str:
    """Returns the snapshot id used by the election (re-uses an existing one made
    from the same model version, so the command is idempotent)."""
    if sc.state_code <= 37:
        raise ValueError("synthetic scenarios must use a state code that does not exist (> 37)")
    with conn.transaction():
        units = [u for u in sc.units if u.pu_code not in sc.existing_units]
        if units:
            conn.execute(
                """insert into public.polling_units (pu_code, state, lga, ward, name, location_desc, geom, geom_source, geom_conf)
                   select x.pu_code, %s, x.lga, x.ward, x.name, 'Synthetic unit (not a real polling unit)',
                          extensions.st_setsrid(extensions.st_makepoint(x.lng, x.lat), 4326)::extensions.geography,
                          'crowd', 0.5
                     from jsonb_to_recordset(%s) as x(pu_code text, lga text, ward text, name text,
                                                      lat float8, lng float8)
                   on conflict (pu_code) do nothing""",
                (sc.state_name, Jsonb([{"pu_code": u.pu_code, "lga": u.lga, "ward": u.ward, "name": u.name,
                                        "lat": u.lat, "lng": u.lng} for u in units])))
        conn.execute(
            """insert into public.model_versions (id, feature_version, metrics, is_current)
               values (%s, 'synthetic', %s, false) on conflict (id) do nothing""",
            (sc.model_version, Jsonb({"synthetic": True, "scenario": sc.name})))
        preds = [{"pu_code": u.pu_code, "mnc": c.mnc, "p": c.p, "p_lo": c.p_lo, "p_hi": c.p_hi,
                  "n_tests": c.n_tests, "n_devices": c.n_devices, "n_evenings": c.n_evenings,
                  "measured": c.measured} for u in sc.units for c in u.carriers]
        conn.execute(
            """insert into public.predictions (pu_code, mcc, mnc, model_version, p_model, p, p_lo, p_hi,
                                               n_tests, n_devices, n_evenings, measured)
               select x.pu_code, 621, x.mnc, %s, x.p, x.p, x.p_lo, x.p_hi, x.n_tests, x.n_devices,
                      x.n_evenings, x.measured
                 from jsonb_to_recordset(%s) as x(pu_code text, mnc int, p numeric, p_lo numeric, p_hi numeric,
                                                  n_tests int, n_devices int, n_evenings int, measured bool)
               on conflict do nothing""", (sc.model_version, Jsonb(preds)))
        conn.execute(
            """insert into public.elections (id, name, election_date, state_codes, polls_close_at, is_replay)
               values (%s, %s, %s, %s, %s, true) on conflict (id) do nothing""",
            (sc.election_id, sc.election_name, sc.polls_close_at.date(), [sc.state_code], sc.polls_close_at))
        r = conn.execute(
            """select s.id::text as id from public.elections e join public.snapshots s on s.id = e.snapshot_id
                where e.id = %s and s.model_version = %s""", (sc.election_id, sc.model_version)).fetchone()
        if r is not None:
            return r["id"]
        return str(conn.execute("select public.freeze_snapshot(%s, %s) as id",
                                (sc.election_id, sc.model_version)).fetchone()["id"])
