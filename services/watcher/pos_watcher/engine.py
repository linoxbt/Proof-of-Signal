"""Pure election-night maths (contracts/api.md, "Watcher maths").

Nothing here touches the database, the network or the clock: every function
takes plain values and returns plain values, so the acceptance behaviour can
be tested exhaustively. The inputs are only

* frozen best-carrier scores (from ``frozen_predictions`` of the election's
  snapshot, never live predictions),
* the frozen config,
* reference data about units (ward, name, point, registered serving cells),
* the times at which units first showed as uploaded (never any result content).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Literal, Mapping, Sequence

from .config import CAVEAT, WatcherConfig

Stratum = Literal["strong", "mid", "weak", "unknown"]
FlagClass = Literal["HELD_SYSTEM_STALL", "NOT_MEASURED", "PLAUSIBLE_NETWORK", "UNEXPLAINED_DELAY", "WATCH"]
CellKey = tuple  # (radio, mcc, mnc, area, cid)


# ---------------------------------------------------------------------------
# Frozen scores
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CarrierScore:
    mcc: int
    mnc: int
    carrier: str | None
    p: float
    p_lo: float
    p_hi: float
    n_tests: int = 0
    n_devices: int = 0
    n_evenings: int = 0
    measured: bool = False


@dataclass(frozen=True)
class UnitScore:
    p: float
    p_lo: float
    p_hi: float
    measured: bool
    n_tests: int
    n_devices: int
    n_evenings: int
    carriers: tuple[CarrierScore, ...] = ()
    has_prediction: bool = True

    @property
    def width(self) -> float:
        return self.p_hi - self.p_lo


NO_PREDICTION = UnitScore(p=0.5, p_lo=0.0, p_hi=1.0, measured=False, n_tests=0, n_devices=0,
                          n_evenings=0, carriers=(), has_prediction=False)


def _best(values: Iterable[float]) -> float:
    """1 − Π(1 − p): chance at least one carrier gets through (independence)."""
    fail = 1.0
    for v in values:
        fail *= max(1.0 - float(v), 1e-9)
    return round(1.0 - fail, 4)


def best_carrier(rows: Sequence[CarrierScore]) -> UnitScore:
    """Best-carrier score of one unit from its frozen per-carrier rows.

    ``n_tests`` sums over carriers (as ``coverage_best_carrier`` does);
    ``n_devices`` and ``n_evenings`` take the maximum, since one dual-SIM
    device or evening is counted under each carrier it measured.
    """
    if not rows:
        return NO_PREDICTION
    return UnitScore(
        p=_best(r.p for r in rows),
        p_lo=_best(r.p_lo for r in rows),
        p_hi=_best(r.p_hi for r in rows),
        measured=any(r.measured for r in rows),
        n_tests=sum(r.n_tests for r in rows),
        n_devices=max(r.n_devices for r in rows),
        n_evenings=max(r.n_evenings for r in rows),
        carriers=tuple(sorted(rows, key=lambda r: (-r.p, r.mnc))),
    )


def stratum(score: UnitScore, cfg: WatcherConfig) -> Stratum:
    if not score.has_prediction:
        return "unknown"
    if score.p >= cfg.strong_cut:
        return "strong"
    if score.p <= cfg.weak_cut:
        return "weak"
    return "mid"


# ---------------------------------------------------------------------------
# Units and neighbours
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Unit:
    pu_code: str
    name: str
    ward: str
    lga: str
    state_code: int
    lat: float | None = None
    lng: float | None = None
    cells: frozenset = field(default_factory=frozenset)  # registered cells of accepted tests

    @property
    def ward_key(self) -> str:
        return self.pu_code.rsplit("-", 1)[0]  # SS-LL-WW: ward codes repeat across LGAs


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_neighbourhoods(units: Iterable[Unit]) -> dict[str, dict[str, str]]:
    """For each unit, the other units sharing its ward ('ward') or a registered
    serving cell ('cell'). Ward wins when both hold. Cell data is optional:
    with none, neighbours are ward-mates only."""
    units = list(units)
    by_ward: dict[str, list[str]] = {}
    by_cell: dict[CellKey, list[str]] = {}
    for u in units:
        by_ward.setdefault(u.ward_key, []).append(u.pu_code)
        for c in u.cells:
            by_cell.setdefault(c, []).append(u.pu_code)
    out: dict[str, dict[str, str]] = {}
    for u in units:
        nb: dict[str, str] = {}
        for c in u.cells:
            for other in by_cell.get(c, ()):
                if other != u.pu_code:
                    nb[other] = "cell"
        for other in by_ward[u.ward_key]:
            if other != u.pu_code:
                nb[other] = "ward"
        out[u.pu_code] = nb
    return out


def uploaded_neighbours(pu_code: str, neighbourhoods: Mapping[str, Mapping[str, str]],
                        uploaded: Mapping[str, datetime]) -> list[str]:
    return [o for o in neighbourhoods.get(pu_code, {}) if o in uploaded]


def neighbour_count(pu_code: str, neighbourhoods: Mapping[str, Mapping[str, str]],
                    uploaded: Mapping[str, datetime], cfg: WatcherConfig) -> int:
    """m: uploaded units sharing the ward or a serving cell, capped (5)."""
    return min(cfg.neighbour_cap, len(uploaded_neighbours(pu_code, neighbourhoods, uploaded)))


# ---------------------------------------------------------------------------
# S(t) and the three-cause posterior
# ---------------------------------------------------------------------------

def strong_pending_share(units: Iterable[Unit], scores: Mapping[str, UnitScore],
                         uploaded: Mapping[str, datetime], cancelled: Iterable[str],
                         cfg: WatcherConfig) -> dict[int, float]:
    """S(t) per state: share of strong-stratum units not uploaded (floor 0.001).
    Cancelled units are left out of both counts."""
    cancelled = set(cancelled)
    total: dict[int, int] = {}
    pending: dict[int, int] = {}
    for u in units:
        total.setdefault(u.state_code, 0)
        pending.setdefault(u.state_code, 0)
        if u.pu_code in cancelled:
            continue
        if stratum(scores.get(u.pu_code, NO_PREDICTION), cfg) != "strong":
            continue
        total[u.state_code] += 1
        if u.pu_code not in uploaded:
            pending[u.state_code] += 1
    return {s: max(cfg.s_floor, (pending[s] / total[s]) if total[s] else cfg.s_floor) for s in total}


@dataclass(frozen=True)
class Posterior:
    p_network: float
    p_other: float
    p_delay: float


def posterior(p: float, m: int, s_t: float, cfg: WatcherConfig) -> Posterior:
    """N = (1 − p)·r^m, O = p·q, D = p·(1 − q)·S(t), normalised."""
    q, r = cfg.prior_other_q, cfg.neighbour_factor_r
    n = (1.0 - p) * r ** m
    o = p * q
    d = p * (1.0 - q) * s_t
    z = n + o + d
    if z <= 0:  # only when p = 0 and q = 0
        return Posterior(1.0, 0.0, 0.0)
    return Posterior(n / z, o / z, d / z)


def classify(score: UnitScore, post: Posterior, m: int, stall_open: bool, cfg: WatcherConfig) -> FlagClass:
    """Classes for a pending unit, checked in contract order."""
    if stall_open:
        return "HELD_SYSTEM_STALL"
    if not score.measured and score.width > cfg.not_measured_interval:
        return "NOT_MEASURED"
    if post.p_network >= cfg.p_network_plausible:
        return "PLAUSIBLE_NETWORK"
    if post.p_other >= cfg.p_other_flag and score.measured and m >= cfg.neighbour_min:
        return "UNEXPLAINED_DELAY"
    return "WATCH"


# ---------------------------------------------------------------------------
# System stall
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StallMetrics:
    strong_recent_rate: float
    strong_trailing_rate: float
    weak_recent_rate: float
    weak_trailing_rate: float
    strong_ratio: float | None  # None: trailing 0 and recent > 0 (not stalled)
    weak_ratio: float | None
    pending_share: float
    strong_pending_share: float
    cond_rate: bool
    cond_pending: bool
    cond_ratio: bool
    expected_recent: float

    @property
    def stalled(self) -> bool:
        return self.cond_rate and self.cond_pending and self.cond_ratio

    def as_evidence(self) -> dict:
        r4 = lambda v: None if v is None else round(v, 4)  # noqa: E731
        return {
            "strong_recent_rate": r4(self.strong_recent_rate),
            "strong_trailing_rate": r4(self.strong_trailing_rate),
            "weak_recent_rate": r4(self.weak_recent_rate),
            "weak_trailing_rate": r4(self.weak_trailing_rate),
            "strong_ratio": r4(self.strong_ratio),
            "weak_ratio": r4(self.weak_ratio),
            "ratio_diff": r4(abs(self.strong_ratio - self.weak_ratio))
            if self.strong_ratio is not None and self.weak_ratio is not None else None,
            "pending_share": r4(self.pending_share),
            "strong_pending_share": r4(self.strong_pending_share),
        }


def _ratio(recent: float, trailing: float) -> float | None:
    if trailing > 0:
        return recent / trailing
    return 1.0 if recent == 0 else None


def stall_metrics(now: datetime, units: Iterable[Unit], scores: Mapping[str, UnitScore],
                  uploaded: Mapping[str, datetime], cancelled: Iterable[str],
                  cfg: WatcherConfig) -> StallMetrics:
    """Upload rates per stratum (uploads per minute) over the recent window
    (``stall_window_min``) and the trailing window before it (30 minutes)."""
    cancelled = set(cancelled)
    w, tr = cfg.stall_window_min * 60.0, cfg.stall_trailing_min * 60.0
    counts = {"strong": [0, 0], "weak": [0, 0]}
    n_active = n_pending = n_strong = n_strong_pending = 0
    for u in units:
        if u.pu_code in cancelled:
            continue
        n_active += 1
        st = stratum(scores.get(u.pu_code, NO_PREDICTION), cfg)
        n_strong += st == "strong"
        at = uploaded.get(u.pu_code)
        if at is None:
            n_pending += 1
            n_strong_pending += st == "strong"
            continue
        if st not in counts:
            continue
        age = (now - at).total_seconds()
        if 0 <= age < w:
            counts[st][0] += 1
        elif w <= age < w + tr:
            counts[st][1] += 1
    sr, st_ = counts["strong"][0] / cfg.stall_window_min, counts["strong"][1] / cfg.stall_trailing_min
    wr, wt = counts["weak"][0] / cfg.stall_window_min, counts["weak"][1] / cfg.stall_trailing_min
    s_ratio, w_ratio = _ratio(sr, st_), _ratio(wr, wt)
    expected = st_ * cfg.stall_window_min
    cond_rate = sr < cfg.stall_rate_frac * st_ and expected >= cfg.stall_min_expected
    pending_share = n_pending / n_active if n_active else 0.0
    strong_share = n_strong_pending / n_strong if n_strong else 0.0
    cond_ratio = (s_ratio is not None and w_ratio is not None
                  and abs(s_ratio - w_ratio) < cfg.stall_ratio_diff)
    # Condition 2 is read on the strong stratum as well as overall: a stall is
    # a large strong backlog that stopped moving. Once 95% of strong units are
    # in, a quiet strong stratum is just the end of the night (or a handful of
    # held-back units, which is exactly what UNEXPLAINED_DELAY is for).
    cond_pending = pending_share > cfg.stall_pending_frac and strong_share > cfg.stall_pending_frac
    return StallMetrics(sr, st_, wr, wt, s_ratio, w_ratio, pending_share, strong_share, cond_rate,
                        cond_pending, cond_ratio, expected)


@dataclass(frozen=True)
class OpenStall:
    id: int | None
    started_at: datetime
    baseline_rate: float  # strong trailing rate when the stall opened


def stall_decision(metrics: StallMetrics, open_stall: OpenStall | None,
                   cfg: WatcherConfig) -> Literal["open", "close", "keep", "none"]:
    """Open when all three conditions hold. An open stall closes when condition 1
    stops holding, judged against the strong upload rate measured when the
    stall opened (once the trailing window itself falls inside the stall, the
    live trailing rate is ~0 and could never show the freeze), or when the
    strong backlog is gone (nothing is being held any more)."""
    if open_stall is None:
        return "open" if metrics.stalled else "none"
    still = (metrics.strong_recent_rate < cfg.stall_rate_frac * open_stall.baseline_rate
             and metrics.strong_pending_share > cfg.stall_pending_frac)
    return "keep" if still else "close"


# ---------------------------------------------------------------------------
# Evidence card and per-tick evaluation
# ---------------------------------------------------------------------------

def _iso(ts: datetime) -> str:
    return ts.isoformat().replace("+00:00", "Z")


def build_evidence(unit: Unit, score: UnitScore, post: Posterior, s_t: float, minutes_since_close: int,
                   neighbours: Sequence[dict], neighbours_uploaded: int,
                   snapshot_id: str, snapshot_sha256: str) -> dict:
    """The evidence card exactly as contracts/api.md describes it."""
    r4 = lambda v: round(float(v), 4)  # noqa: E731
    return {
        "pu_code": unit.pu_code,
        "name": unit.name,
        "ward": unit.ward,
        "lga": unit.lga,
        "snapshot_id": str(snapshot_id),
        "snapshot_sha256": snapshot_sha256,
        "measured": score.measured,
        "n_tests": score.n_tests,
        "n_devices": score.n_devices,
        "n_evenings": score.n_evenings,
        "carriers": [{"mnc": c.mnc, "carrier": c.carrier, "p": r4(c.p), "p_lo": r4(c.p_lo), "p_hi": r4(c.p_hi)}
                     for c in score.carriers],
        "p_best": r4(score.p),
        "p_best_lo": r4(score.p_lo),
        "p_best_hi": r4(score.p_hi),
        "neighbours": list(neighbours),
        "neighbours_uploaded": neighbours_uploaded,
        "minutes_since_close": minutes_since_close,
        "minutes_pending": minutes_since_close,
        "s_t": r4(s_t),
        "p_network": r4(post.p_network),
        "p_other": r4(post.p_other),
        "p_delay": r4(post.p_delay),
        "caveat": CAVEAT,
    }


def neighbour_list(unit: Unit, units_by_code: Mapping[str, Unit], nb: Mapping[str, str],
                   uploaded: Mapping[str, datetime], limit: int = 10) -> list[dict]:
    """Uploaded neighbours, nearest first (units with no point last)."""
    rows = []
    for code, shared in nb.items():
        at = uploaded.get(code)
        if at is None:
            continue
        o = units_by_code[code]
        dist = (round(haversine_m(unit.lat, unit.lng, o.lat, o.lng))
                if None not in (unit.lat, unit.lng, o.lat, o.lng) else None)
        rows.append({"pu_code": code, "name": o.name, "dist_m": dist, "uploaded_at": _iso(at), "shared": shared})
    rows.sort(key=lambda r: (r["dist_m"] is None, r["dist_m"] or 0, r["uploaded_at"], r["pu_code"]))
    return rows[:limit]


@dataclass(frozen=True)
class UnitResult:
    pu_code: str
    flag_class: FlagClass
    p_network: float
    p_other: float
    p_delay: float
    m: int
    evidence: dict


@dataclass(frozen=True)
class TickOutcome:
    t_min: float
    metrics: StallMetrics | None
    stall_action: Literal["open", "close", "keep", "none"]
    stall_open: bool
    s_t: dict[int, float]
    results: dict[str, UnitResult]


@dataclass
class ElectionModel:
    """Static inputs for one election night, loaded once."""
    election_id: str
    polls_close_at: datetime
    snapshot_id: str
    snapshot_sha256: str
    cfg: WatcherConfig
    units: list[Unit]
    scores: dict[str, UnitScore]
    neighbourhoods: dict[str, dict[str, str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.neighbourhoods:
            self.neighbourhoods = build_neighbourhoods(self.units)
        self.units_by_code = {u.pu_code: u for u in self.units}


def evaluate(model: ElectionModel, now: datetime, uploaded_all: Mapping[str, datetime],
             cancelled: Iterable[str], open_stall: OpenStall | None) -> TickOutcome:
    """One tick: stall decision, then a class for every pending unit."""
    cfg = model.cfg
    cancelled = set(cancelled)
    uploaded = {k: v for k, v in uploaded_all.items() if v <= now}
    t_min = (now - model.polls_close_at).total_seconds() / 60.0
    if t_min < 0:
        return TickOutcome(t_min, None, "none", open_stall is not None, {}, {})

    metrics = stall_metrics(now, model.units, model.scores, uploaded, cancelled, cfg)
    action = stall_decision(metrics, open_stall, cfg)
    stall_open = action in ("open", "keep")
    s_t = strong_pending_share(model.units, model.scores, uploaded, cancelled, cfg)
    minutes = int(t_min)

    results: dict[str, UnitResult] = {}
    for u in model.units:
        if u.pu_code in uploaded or u.pu_code in cancelled:
            continue
        score = model.scores.get(u.pu_code, NO_PREDICTION)
        nb = model.neighbourhoods.get(u.pu_code, {})
        up_nb = [c for c in nb if c in uploaded]
        m = min(cfg.neighbour_cap, len(up_nb))
        s = s_t.get(u.state_code, cfg.s_floor)
        post = posterior(score.p, m, s, cfg)
        cls = classify(score, post, m, stall_open, cfg)
        ev = build_evidence(u, score, post, s, minutes, neighbour_list(u, model.units_by_code, nb, uploaded),
                            len(up_nb), model.snapshot_id, model.snapshot_sha256)
        results[u.pu_code] = UnitResult(u.pu_code, cls, post.p_network, post.p_other, post.p_delay, m, ev)
    return TickOutcome(t_min, metrics, action, stall_open, s_t, results)
