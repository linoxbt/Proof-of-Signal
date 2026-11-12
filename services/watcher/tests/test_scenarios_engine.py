"""Robustness of the three acceptance behaviours across generator seeds,
using the pure engine only (the DB versions in test_acceptance_db.py run the
default seeds end to end)."""

from datetime import timedelta

import pytest

from pos_watcher.adapters.synthetic import scenario_demo, scenario_holdout, scenario_outage, scenario_stall
from pos_watcher.config import WatcherConfig
from pos_watcher.engine import CarrierScore, ElectionModel, OpenStall, Unit, best_carrier, evaluate


def model_of(sc):
    units = [Unit(u.pu_code, u.name, u.ward, u.lga, sc.state_code, u.lat, u.lng) for u in sc.units]
    scores = {u.pu_code: best_carrier([CarrierScore(621, c.mnc, None, c.p, c.p_lo, c.p_hi, c.n_tests, c.n_devices,
                                                    c.n_evenings, c.measured) for c in u.carriers])
              for u in sc.units}
    return ElectionModel(sc.election_id, sc.polls_close_at, "snap", "sha", WatcherConfig(), units, scores)


def night(sc, until_min):
    m, up, stall, out = model_of(sc), {e.pu_code: e.at for e in sc.events}, None, []
    for k in range(int(until_min // 2) + 1):
        now = sc.polls_close_at + timedelta(minutes=2 * k)
        o = evaluate(m, now, up, set(), stall)
        if o.stall_action == "open":
            stall = OpenStall(None, now, o.metrics.strong_trailing_rate)
        elif o.stall_action == "close":
            stall = None
        out.append(o)
    return out


SEEDS = range(1, 11)


@pytest.mark.parametrize("seed", SEEDS)
def test_stall_seeds(seed):
    sc = scenario_stall(seed)
    ticks = night(sc, 240)
    opens = [o.t_min for o in ticks if o.stall_action == "open"]
    assert len(opens) == 1 and 0 <= opens[0] - sc.meta["freeze_start_min"] <= 25
    for o in ticks:
        if o.stall_open:
            assert all(r.flag_class == "HELD_SYSTEM_STALL" for r in o.results.values())


@pytest.mark.parametrize("seed", SEEDS)
def test_outage_seeds(seed):
    sc = scenario_outage(seed)
    cluster = set(sc.meta["cluster"])
    ticks = night(sc, 200)
    assert not any(o.stall_open for o in ticks)
    assert not any(o.results[p].flag_class == "UNEXPLAINED_DELAY" for o in ticks for p in cluster if p in o.results)
    assert all(ticks[-1].results[p].flag_class == "PLAUSIBLE_NETWORK" for p in cluster)


@pytest.mark.parametrize("seed", SEEDS)
def test_holdout_seeds(seed):
    sc = scenario_holdout(seed)
    held = set(sc.meta["held"])
    ticks = night(sc, 178)
    last = ticks[-1].results
    assert sum(last[p].flag_class == "UNEXPLAINED_DELAY" for p in held) >= 18
    ever = {p for o in ticks for p, r in o.results.items() if r.flag_class == "UNEXPLAINED_DELAY"} - held
    assert len(ever) < 0.02 * (len(sc.units) - len(held))
    assert not any(o.stall_open for o in ticks)


def test_demo_story():
    sc = scenario_demo()
    ticks = night(sc, 300)
    opens = [o.t_min for o in ticks if o.stall_action == "open"]
    closes = [o.t_min for o in ticks if o.stall_action == "close"]
    assert len(opens) == 1 and sc.meta["freeze_start_min"] <= opens[0] <= sc.meta["freeze_start_min"] + 25
    assert len(closes) == 1 and closes[0] >= sc.meta["freeze_end_min"]
    dark = sc.meta["dark_unit"]
    assert ticks[-1].results[dark].flag_class == "UNEXPLAINED_DELAY"
    assert ticks[-1].results[dark].m >= 3
