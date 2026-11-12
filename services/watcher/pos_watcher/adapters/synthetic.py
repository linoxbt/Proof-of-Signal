"""Synthetic election nights for the spec's replay tests and the demo.

Everything here is invented. State codes 96-99 do not exist in Nigeria
(codes run 01-37), every unit is named "Synthetic ...", and no vote data is
modelled at all, only upload times.

Upload model (per unit):

* counting finishes at ``10 + LogNormal(median 45, sigma 0.4)`` minutes after
  polls close;
* the unit uploads at the first moment after that when its ward's serving
  cell is up, plus 0-4 minutes of transmission;
* strong wards' cells are always up; mid and weak wards' cells alternate
  up/down (exponential periods) so a weak ward's units upload in bursts,
  as neighbours on one bad mast would.

Coverage scores follow the ward kind: strong wards have best-carrier p about
0.9-0.99, mid about 0.45-0.75, weak about 0.1-0.35; about 85% of units are
measured (tight intervals), the rest have 0.5-wide intervals.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

from . import UploadEvent

WardKind = Literal["strong", "mid", "weak"]
CARRIER_NAMES = {30: "MTN", 20: "Airtel", 50: "Glo", 60: "9mobile"}


@dataclass
class SynthCarrier:
    mnc: int
    p: float
    p_lo: float
    p_hi: float
    n_tests: int
    n_devices: int
    n_evenings: int
    measured: bool


@dataclass
class SynthUnit:
    pu_code: str
    name: str
    ward: str
    lga: str
    lat: float
    lng: float
    kind: WardKind
    carriers: list[SynthCarrier]

    @property
    def p_best(self) -> float:
        f = 1.0
        for c in self.carriers:
            f *= 1 - c.p
        return 1 - f

    @property
    def measured(self) -> bool:
        return any(c.measured for c in self.carriers)

    @property
    def ward_key(self) -> str:
        return self.pu_code.rsplit("-", 1)[0]


@dataclass
class Scenario:
    name: str
    election_id: str
    election_name: str
    state_code: int
    state_name: str
    polls_close_at: datetime
    units: list[SynthUnit]
    events: list[UploadEvent]
    meta: dict = field(default_factory=dict)
    model_version: str = ""
    existing_units: set[str] = field(default_factory=set)  # already in seed.sql; not inserted

    def __post_init__(self) -> None:
        if not self.model_version:
            self.model_version = f"synthetic-{self.name}-1"


def _r4(x: float) -> float:
    return round(min(1.0, max(0.0, x)), 4)


def _carriers(rng: random.Random, kind: WardKind, measured: bool) -> list[SynthCarrier]:
    lo, hi = {"strong": (0.82, 0.97), "mid": (0.35, 0.6), "weak": (0.08, 0.25)}[kind]
    p1 = rng.uniform(lo, hi)
    p2 = p1 * rng.uniform(0.3, 0.7)
    out = []
    for i, (mnc, p) in enumerate(((30, p1), (20, p2))):
        meas = measured and i == 0
        if meas:
            half = rng.uniform(0.03, 0.08)
            out.append(SynthCarrier(mnc, _r4(p), _r4(p - half), _r4(p + half), rng.randint(3, 6),
                                    rng.randint(2, 3), rng.randint(2, 3), True))
        else:
            out.append(SynthCarrier(mnc, _r4(p), _r4(p - 0.25), _r4(p + 0.25), rng.randint(0, 2),
                                    rng.randint(0, 1), rng.randint(0, 1), False))
    return out


def build_population(rng: random.Random, state_code: int, lgas: range, wards_per_lga: int,
                     units_per_ward: int, mix: tuple[float, float, float] = (0.7, 0.15, 0.15),
                     measured_frac: float = 0.85, lga_name=None, ward_name=None,
                     first_unit: int = 1, ward_kinds: dict[str, WardKind] | None = None,
                     origin: tuple[float, float] = (8.5, 4.6)) -> list[SynthUnit]:
    units = []
    lga_name = lga_name or (lambda l: f"Synthetic LGA {l:02d}")
    ward_name = ward_name or (lambda l, w: f"Synthetic Ward {l:02d}-{w:02d}")
    for l in lgas:
        for w in range(1, wards_per_lga + 1):
            key = f"{state_code:02d}-{l:02d}-{w:02d}"
            kind = (ward_kinds or {}).get(key) or rng.choices(("strong", "mid", "weak"), weights=mix)[0]
            clat = origin[0] + 0.15 * (l - 1) + 0.012 * (w - 1)
            clng = origin[1] + 0.05 * (w % 4)
            for u in range(first_unit, first_unit + units_per_ward):
                code = f"{key}-{u:03d}"
                units.append(SynthUnit(
                    code, f"Synthetic PU {code}", ward_name(l, w), lga_name(l),
                    round(clat + rng.uniform(-0.006, 0.006), 6), round(clng + rng.uniform(-0.006, 0.006), 6),
                    kind, _carriers(rng, kind, rng.random() < measured_frac)))
    return units


def _cell_up_periods(rng: random.Random, kind: WardKind, horizon: float) -> list[tuple[float, float]]:
    """Up intervals (minutes since close) of a ward's serving cell."""
    if kind == "strong":
        return [(-1e9, 1e9)]
    up_mean, down_mean = {"mid": (40.0, 15.0), "weak": (15.0, 45.0)}[kind]
    up = rng.random() < up_mean / (up_mean + down_mean)
    t, out = -60.0, []
    while t < horizon:
        d = rng.expovariate(1 / (up_mean if up else down_mean))
        if up:
            out.append((t, t + d))
        t += d
        up = not up
    return out


def counting_done(rng: random.Random) -> float:
    return 10 + 45 * math.exp(rng.gauss(0, 0.4))


def simulate_upload_minutes(rng: random.Random, units: list[SynthUnit], horizon: float = 360,
                            cell_periods: dict[str, list[tuple[float, float]]] | None = None) -> dict[str, float]:
    """Minutes after close at which each unit uploads (absent = never within horizon)."""
    periods = dict(cell_periods or {})
    out = {}
    for u in units:
        if u.ward_key not in periods:
            periods[u.ward_key] = _cell_up_periods(rng, u.kind, horizon)
        c = counting_done(rng)
        for a, b in periods[u.ward_key]:
            if b > c:
                t = max(a, c) + rng.uniform(0, 4)
                if t <= horizon:
                    out[u.pu_code] = t
                break
    return out


def _events(close: datetime, minutes: dict[str, float]) -> list[UploadEvent]:
    return sorted((UploadEvent(pu, "uploaded", (close + timedelta(minutes=m)).replace(microsecond=0))
                   for pu, m in minutes.items()), key=lambda e: (e.at, e.pu_code))


CLOSE = datetime(2026, 12, 5, 14, 30, tzinfo=timezone.utc)


def scenario_stall(seed: int = 1) -> Scenario:
    """(a) Every upload freezes for two hours (60-180 min), then the backlog flushes."""
    rng = random.Random(seed)
    units = build_population(rng, 96, range(1, 7), 10, 10)
    mins = simulate_upload_minutes(rng, units)
    f0, f1 = 60.0, 180.0
    for pu, m in mins.items():
        if f0 <= m < f1:
            mins[pu] = f1 + rng.uniform(0, 15)
    return Scenario("stall", "synthetic-stall", "Synthetic: two-hour system freeze", 96,
                    "Synthetic State 96", CLOSE, units, _events(CLOSE, mins),
                    {"freeze_start_min": f0, "freeze_end_min": f1})


def scenario_outage(seed: int = 2) -> Scenario:
    """(b) Two weak wards on one mast stay dark until 240 min while the rest upload."""
    rng = random.Random(seed)
    cluster_wards = {"97-02-03": "weak", "97-02-04": "weak"}
    units = build_population(rng, 97, range(1, 6), 10, 10, ward_kinds=cluster_wards)
    cluster = [u for u in units if u.ward_key in cluster_wards]
    for u in cluster:  # the cluster is well measured: the point is that measured weak units read as network
        u.carriers = _carriers(rng, "weak", True)
    shared = [(240.0, 1e9)]
    mins = simulate_upload_minutes(rng, units, cell_periods={k: shared for k in cluster_wards})
    return Scenario("outage", "synthetic-outage", "Synthetic: weak cluster uploads late", 97,
                    "Synthetic State 97", CLOSE, units, _events(CLOSE, mins),
                    {"cluster": sorted(u.pu_code for u in cluster), "cluster_cell": ("LTE", 621, 30, 9701, 1),
                     "cluster_up_min": 240.0})


def scenario_holdout(seed: int = 3, n_held: int = 20) -> Scenario:
    """(c) 1,000 units; 20 measured strong units in different wards are held back
    3 hours (upload 185-210 min) while everything else behaves normally."""
    rng = random.Random(seed)
    units = build_population(rng, 98, range(1, 11), 10, 10)
    mins = simulate_upload_minutes(rng, units)
    by_ward: dict[str, list[SynthUnit]] = {}
    for u in units:
        if u.kind == "strong" and u.measured and u.p_best >= 0.9:
            by_ward.setdefault(u.ward_key, []).append(u)
    wards = sorted(by_ward)
    rng.shuffle(wards)
    held = [rng.choice(by_ward[w]) for w in wards[:n_held]]
    for u in held:
        mins[u.pu_code] = 180 + rng.uniform(5, 30)
    return Scenario("holdout", "synthetic-holdout", "Synthetic: 20 strong units held back", 98,
                    "Synthetic State 98", CLOSE, units, _events(CLOSE, mins),
                    {"held": sorted(u.pu_code for u in held), "hold_until_min": 180.0})


SEED_UNITS = {  # supabase/seed.sql, state 99
    "99-01-01-001": ("Demo Primary School I", "Ward A", 8.4900, 4.5500),
    "99-01-01-002": ("Demo Market Square", "Ward A", 8.4930, 4.5560),
    "99-01-01-003": ("Demo Town Hall", "Ward A", 8.4870, 4.5610),
    "99-01-02-001": ("Demo Health Centre", "Ward B", 8.5400, 4.6200),
    "99-01-02-002": ("Demo Village Square", "Ward B", None, None),
}
DEMO_CLOSE = datetime(2026, 12, 12, 14, 30, tzinfo=timezone.utc)  # seed.sql polls_close_at
DEMO_DARK_UNIT = "99-01-01-001"


def scenario_demo(seed: int = 99) -> Scenario:
    """The replay-demo story for the seeded election: uploads flow, a system-wide
    freeze (80-150 min), uploads resume, and Demo Primary School I (strong,
    measured) stays dark while its Ward A neighbours upload."""
    rng = random.Random(seed)
    lga_names = {1: "Demo North", 2: "Demo South (synthetic)", 3: "Demo East (synthetic)",
                 4: "Demo West (synthetic)"}
    ward_names = lambda l, w: ({1: "Ward A", 2: "Ward B"}.get(w) if l == 1 else None) or \
        f"Synthetic Ward {l:02d}-{w:02d}"  # noqa: E731
    kinds = {"99-01-01": "strong", "99-01-02": "mid", "99-03-05": "weak", "99-03-06": "weak"}
    units = build_population(rng, 99, range(1, 5), 8, 10, lga_name=lambda l: lga_names[l],
                             ward_name=ward_names, ward_kinds=kinds, origin=(8.49, 4.55))
    for u in units:
        if u.pu_code in SEED_UNITS:
            name, ward, lat, lng = SEED_UNITS[u.pu_code]
            u.name, u.ward, u.lat, u.lng = name, ward, lat, lng
    dark = next(u for u in units if u.pu_code == DEMO_DARK_UNIT)
    dark.carriers = [SynthCarrier(30, 0.95, 0.9, 0.98, 5, 3, 3, True),
                     SynthCarrier(20, 0.71, 0.6, 0.8, 3, 2, 2, True)]
    mins = simulate_upload_minutes(rng, units, horizon=330)
    f0, f1 = 80.0, 150.0
    for pu, m in mins.items():
        if f0 <= m < f1:
            mins[pu] = f1 + rng.uniform(0, 12)
    mins.pop(DEMO_DARK_UNIT, None)
    for code in ("99-01-01-002", "99-01-01-003"):  # neighbours upload before the freeze
        mins[code] = rng.uniform(45, 70)
    return Scenario("demo", "replay-demo", "Synthetic replay (demo)", 99, "Demo State", DEMO_CLOSE, units,
                    _events(DEMO_CLOSE, mins),
                    {"freeze_start_min": f0, "freeze_end_min": f1, "dark_unit": DEMO_DARK_UNIT},
                    model_version="synthetic-demo-1", existing_units=set(SEED_UNITS))


SCENARIOS = {"stall": scenario_stall, "outage": scenario_outage, "holdout": scenario_holdout,
             "demo": scenario_demo}
