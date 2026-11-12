from datetime import datetime, timedelta, timezone

import pytest

from pos_watcher.config import CAVEAT, WatcherConfig
from pos_watcher.engine import (
    CarrierScore, ElectionModel, OpenStall, Posterior, Unit, UnitScore, best_carrier, build_evidence,
    build_neighbourhoods, classify, evaluate, neighbour_count, posterior, stall_decision, stall_metrics,
    strong_pending_share, stratum,
)

CFG = WatcherConfig()
T0 = datetime(2026, 12, 5, 14, 30, tzinfo=timezone.utc)


# --- the contract's worked numbers -----------------------------------------

def test_posterior_strong_unit_while_much_is_pending():
    post = posterior(0.95, 3, 0.5, CFG)
    assert post.p_other == pytest.approx(0.10, abs=0.01)
    assert post.p_network + post.p_other + post.p_delay == pytest.approx(1)


def test_posterior_strong_unit_when_almost_everything_uploaded():
    post = posterior(0.95, 3, 0.01, CFG)
    assert post.p_other == pytest.approx(0.82, abs=0.01)


def test_posterior_weak_unit_alone():
    post = posterior(0.3, 0, 0.01, CFG)
    assert post.p_network == pytest.approx(0.98, abs=0.01)


def test_posterior_terms_exact():
    p, m, s = 0.9, 2, 0.2
    n, o, d = (1 - p) * 0.3 ** m, p * 0.05, p * 0.95 * s
    post = posterior(p, m, s, CFG)
    assert post.p_network == pytest.approx(n / (n + o + d))
    assert post.p_other == pytest.approx(o / (n + o + d))
    assert post.p_delay == pytest.approx(d / (n + o + d))


def test_config_from_frozen_overrides_and_defaults():
    cfg = WatcherConfig.from_frozen({"prior_other_q": 0.1, "neighbour_min": "4", "poll_interval_s": [150, 200],
                                     "unknown": 1})
    assert cfg.prior_other_q == 0.1 and cfg.neighbour_min == 4 and cfg.poll_interval_s == (150, 200)
    assert cfg.strong_cut == 0.8 and cfg.neighbour_factor_r == 0.3


# --- best carrier, strata --------------------------------------------------

def test_best_carrier_combines_independent_carriers():
    s = best_carrier([CarrierScore(621, 30, "MTN", 0.9, 0.8, 0.95, 3, 2, 2, True),
                      CarrierScore(621, 20, "Airtel", 0.5, 0.2, 0.8, 1, 1, 1, False)])
    assert s.p == pytest.approx(0.95)
    assert s.p_lo == pytest.approx(1 - 0.2 * 0.8)
    assert s.p_hi == pytest.approx(1 - 0.05 * 0.2)
    assert s.measured and s.n_tests == 4 and s.n_devices == 2 and s.n_evenings == 2
    assert [c.mnc for c in s.carriers] == [30, 20]


def test_best_carrier_empty_is_no_prediction():
    s = best_carrier([])
    assert not s.has_prediction and not s.measured and s.width == 1
    assert stratum(s, CFG) == "unknown"


@pytest.mark.parametrize("p,expected", [(0.8, "strong"), (0.79, "mid"), (0.41, "mid"), (0.4, "weak")])
def test_strata_cuts(p, expected):
    assert stratum(UnitScore(p, p, p, True, 1, 1, 1), CFG) == expected


# --- neighbours --------------------------------------------------------------

def U(code, cells=(), lat=None, lng=None, state=99):
    return Unit(code, f"PU {code}", "Ward", "LGA", state, lat, lng, frozenset(cells))


def test_neighbours_ward_and_cell():
    cell = ("LTE", 621, 30, 100, 7)
    units = [U("99-01-01-001", [cell]), U("99-01-01-002"), U("99-01-02-001", [cell]), U("99-02-01-001")]
    nb = build_neighbourhoods(units)
    assert nb["99-01-01-001"] == {"99-01-01-002": "ward", "99-01-02-001": "cell"}
    assert nb["99-02-01-001"] == {}
    # Ward 01 in another LGA is a different ward.
    assert "99-02-01-001" not in nb["99-01-01-002"]


def test_neighbour_count_is_capped():
    units = [U(f"99-01-01-{i:03d}") for i in range(1, 9)]
    nb = build_neighbourhoods(units)
    up = {u.pu_code: T0 for u in units[1:]}
    assert neighbour_count("99-01-01-001", nb, up, CFG) == 5
    assert neighbour_count("99-01-01-001", nb, {}, CFG) == 0


# --- S(t) --------------------------------------------------------------------

def test_strong_pending_share_per_state_with_floor_and_cancelled():
    units = [U("99-01-01-001"), U("99-01-01-002"), U("99-01-01-003"), U("98-01-01-001", state=98)]
    strong = UnitScore(0.95, 0.9, 0.99, True, 3, 2, 2)
    weak = UnitScore(0.2, 0.1, 0.3, True, 3, 2, 2)
    scores = {"99-01-01-001": strong, "99-01-01-002": strong, "99-01-01-003": weak, "98-01-01-001": strong}
    s = strong_pending_share(units, scores, {"99-01-01-001": T0}, [], CFG)
    assert s[99] == 0.5
    assert s[98] == 1.0
    s = strong_pending_share(units, scores, {"99-01-01-001": T0}, ["99-01-01-002"], CFG)
    assert s[99] == CFG.s_floor


# --- classes -----------------------------------------------------------------

MEAS = UnitScore(0.95, 0.9, 0.99, True, 4, 2, 2)
UNMEAS_WIDE = UnitScore(0.6, 0.3, 0.8, False, 0, 0, 0)


def test_classes_in_contract_order():
    other = Posterior(0.01, 0.9, 0.09)
    assert classify(MEAS, other, 5, True, CFG) == "HELD_SYSTEM_STALL"
    assert classify(UNMEAS_WIDE, Posterior(0.9, 0.05, 0.05), 0, False, CFG) == "NOT_MEASURED"
    assert classify(MEAS, Posterior(0.6, 0.3, 0.1), 0, False, CFG) == "PLAUSIBLE_NETWORK"
    assert classify(MEAS, other, 3, False, CFG) == "UNEXPLAINED_DELAY"
    assert classify(MEAS, other, 2, False, CFG) == "WATCH"  # too few uploaded neighbours
    narrow_unmeasured = UnitScore(0.95, 0.9, 0.99, False, 0, 0, 0)
    assert classify(narrow_unmeasured, other, 5, False, CFG) == "WATCH"  # unmeasured never UNEXPLAINED


# --- stall detector ----------------------------------------------------------

def _stall_world(n_strong=100, n_weak=40):
    units = [U(f"99-01-{i // 10 + 1:02d}-{i % 10 + 1:03d}") for i in range(n_strong)]
    units += [U(f"99-02-{i // 10 + 1:02d}-{i % 10 + 1:03d}") for i in range(n_weak)]
    scores = {u.pu_code: (UnitScore(0.95, 0.9, 0.99, True, 3, 2, 2) if u.pu_code.startswith("99-01")
                          else UnitScore(0.2, 0.1, 0.3, True, 3, 2, 2)) for u in units}
    return units, scores


def test_stall_all_three_conditions():
    units, scores = _stall_world()
    now = T0 + timedelta(minutes=90)
    # 40 strong + 8 weak uploaded in the trailing window (20-50 min ago), none since.
    up = {u.pu_code: now - timedelta(minutes=30) for u in units[:40]}
    up |= {u.pu_code: now - timedelta(minutes=30) for u in units[100:108]}
    m = stall_metrics(now, units, scores, up, [], CFG)
    assert m.cond_rate and m.cond_pending and m.cond_ratio and m.stalled
    assert stall_decision(m, None, CFG) == "open"


def test_no_stall_when_only_strong_units_stop():
    units, scores = _stall_world()
    now = T0 + timedelta(minutes=90)
    up = {u.pu_code: now - timedelta(minutes=30) for u in units[:40]}
    up |= {u.pu_code: now - timedelta(minutes=30) for u in units[100:105]}
    up |= {u.pu_code: now - timedelta(minutes=5) for u in units[105:110]}  # weak keep flowing
    m = stall_metrics(now, units, scores, up, [], CFG)
    assert m.cond_rate and not m.cond_ratio and not m.stalled


def test_weak_stratum_with_no_trailing_uploads():
    units, scores = _stall_world()
    now = T0 + timedelta(minutes=90)
    up = {u.pu_code: now - timedelta(minutes=30) for u in units[:40]}
    m = stall_metrics(now, units, scores, up, [], CFG)
    assert m.weak_ratio == 1.0 and not m.cond_ratio  # |0 - 1| >= 0.2
    up[units[100].pu_code] = now - timedelta(minutes=1)
    m = stall_metrics(now, units, scores, up, [], CFG)
    assert m.weak_ratio is None and not m.stalled  # recent > 0 with trailing 0: not stalled


def test_thin_tail_is_not_a_stall():
    units, scores = _stall_world()
    now = T0 + timedelta(minutes=200)
    up = {u.pu_code: T0 + timedelta(minutes=60) for u in units[:85]}
    up |= {u.pu_code: now - timedelta(minutes=30) for u in units[85:89]}  # 4 in trailing window
    m = stall_metrics(now, units, scores, up, [], CFG)
    assert m.strong_recent_rate == 0 and m.expected_recent < CFG.stall_min_expected
    assert not m.cond_rate


def test_stall_closes_only_when_rate_recovers_against_baseline():
    units, scores = _stall_world()
    now = T0 + timedelta(minutes=150)
    open_ = OpenStall(1, now - timedelta(minutes=60), baseline_rate=2.0)
    nothing = stall_metrics(now, units, scores, {}, [], CFG)
    assert stall_decision(nothing, open_, CFG) == "keep"  # trailing is 0 too, but baseline holds
    up = {u.pu_code: now - timedelta(minutes=3) for u in units[:10]}  # 0.5/min >= 0.1 * 2.0
    assert stall_decision(stall_metrics(now, units, scores, up, [], CFG), open_, CFG) == "close"


# --- evidence card and evaluate ---------------------------------------------

CONTRACT_KEYS = ["pu_code", "name", "ward", "lga", "snapshot_id", "snapshot_sha256", "measured", "n_tests",
                 "n_devices", "n_evenings", "carriers", "p_best", "p_best_lo", "p_best_hi", "neighbours",
                 "neighbours_uploaded", "minutes_since_close", "minutes_pending", "s_t", "p_network",
                 "p_other", "p_delay", "caveat"]


def test_evidence_card_matches_contract():
    u = U("99-01-01-001", lat=8.49, lng=4.55)
    s = best_carrier([CarrierScore(621, 30, "MTN", 0.92, 0.85, 0.97, 3, 2, 2, True)])
    ev = build_evidence(u, s, posterior(0.92, 5, 0.01, CFG), 0.01, 140,
                        [{"pu_code": "x", "name": "y", "dist_m": 640, "uploaded_at": "z", "shared": "ward"}], 5,
                        "snap", "ab" * 32)
    assert list(ev) == CONTRACT_KEYS
    assert ev["caveat"] == CAVEAT
    assert CAVEAT == ("This system cannot see BVAS faults, flat batteries, late starts, insecurity, cancelled "
                      "polls, tower power cuts or congestion on the day. A flag is a request for human review, "
                      "not a finding.")
    assert ev["carriers"] == [{"mnc": 30, "carrier": "MTN", "p": 0.92, "p_lo": 0.85, "p_hi": 0.97}]


def test_evaluate_end_to_end_small():
    units = [U(f"99-01-01-{i:03d}", lat=8.49 + i * 0.001, lng=4.55) for i in range(1, 7)]
    units.append(U("99-01-02-001"))
    scores = {u.pu_code: UnitScore(0.95, 0.9, 0.99, True, 4, 2, 2) for u in units}
    model = ElectionModel("e", T0, "snap", "sha", CFG, units, scores)
    up = {u.pu_code: T0 + timedelta(minutes=30 + i) for i, u in enumerate(units[1:6])}
    out = evaluate(model, T0 + timedelta(minutes=140), up, [], None)
    assert set(out.results) == {"99-01-01-001", "99-01-02-001"}
    r = out.results["99-01-01-001"]
    assert r.m == 5 and r.evidence["neighbours_uploaded"] == 5
    assert r.evidence["minutes_since_close"] == 140 and r.evidence["minutes_pending"] == 140
    nbs = r.evidence["neighbours"]
    assert [n["dist_m"] for n in nbs] == sorted(n["dist_m"] for n in nbs) and nbs[0]["shared"] == "ward"
    # S(t) = 2/7 pending strong; p_other = .0475 / (.0475 + .05*.3^5 + .95*.95*2/7)
    assert r.p_other == pytest.approx(0.0475 / (0.0475 + 0.05 * 0.3 ** 5 + 0.9025 * 2 / 7), rel=1e-6)
    assert evaluate(model, T0 - timedelta(minutes=1), up, [], None).results == {}  # t < 0: nothing
