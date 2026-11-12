"""Synthetic world for tests and the demo.

Everything is invented: towers, terrain, settlements, Ookla tiles, polling
units in state code 99 (which does not exist in Nigeria) and volunteer tests
drawn from a known ground-truth success function. Nothing here is real data.

Ground truth (evening, per unit and carrier):

    z = 2.4 + carrier_effect - 1.4 ln(1 + d1 / 1 km) - 0.07 obs1_m
        + 0.6 share_4g5g_10km + 0.9 field(x, y) - 0.5 min(pop_2km / 30000, 2)
    p_true = sigmoid(z)

field is a smooth random field (length scale ~10 km) that no input feature
sees directly: the only way to learn it is the spatial context of measured
neighbours. The population term is evening congestion. Daytime tests use
z + 0.8 (less load), which is why they are features, not labels.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import config as C
from .features import compute_features
from .geo import geohash, lnglat_to_tile, offset, tile_neighbourhood, tile_to_quadkey
from .raster import Raster

CARRIERS = {30: "MTN", 20: "Airtel", 50: "Glo", 60: "9mobile"}
CARRIER_EFFECT = {30: 0.35, 20: 0.1, 50: -0.25, 60: -0.6}
MARKET_SHARE = {30: 0.45, 20: 0.30, 50: 0.18, 60: 0.07}
SITES_PER_CARRIER = {30: 70, 20: 50, 50: 35, 60: 12}

# Bounding box around the seed units in supabase/seed.sql (lng 4.55-4.62, lat 8.49-8.54).
BBOX = (4.35, 8.25, 4.95, 8.85)  # west, south, east, north
STATE_CODE = 99
STATE_NAME = "Demo State"


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


@dataclass
class World:
    pus: pd.DataFrame
    cells: pd.DataFrame
    dem: Raster
    population: Raster
    settlements: pd.DataFrame
    ookla: pd.DataFrame
    truth: pd.DataFrame  # pu_code, mnc, z, p_true, p_day
    field_fn: object
    devices: pd.DataFrame | None = None
    tests: pd.DataFrame | None = None
    test_sims: pd.DataFrame | None = None

    def labels(self) -> pd.DataFrame:
        """Evening accepted (test, SIM) rows, as pipeline.load_labels returns them."""
        t = self.tests[self.tests["is_evening"]]
        s = self.test_sims.merge(t[["test_id", "pu_code", "device_id", "local_date", "trust"]], on="test_id")
        s["success"] = s["upload_ok"] & (s["total_ms"].astype(float).fillna(np.inf) <= C.UPLOAD_LIMIT_MS)
        return s[["test_id", "pu_code", "mnc", "success", "trust", "device_id", "local_date", "total_ms"]]

    def day_features(self) -> pd.DataFrame:
        t = self.tests[~self.tests["is_evening"]]
        s = self.test_sims.merge(t[["test_id", "pu_code", "trust"]], on="test_id")
        if s.empty:
            return pd.DataFrame(columns=["pu_code", "mnc", "day_n", "day_rate"])
        s["success"] = s["upload_ok"] & (s["total_ms"].astype(float).fillna(np.inf) <= C.UPLOAD_LIMIT_MS)
        s["ws"] = s["trust"] * s["success"]
        g = s.groupby(["pu_code", "mnc"]).agg(day_n=("test_id", "size"), ws=("ws", "sum"), w=("trust", "sum")).reset_index()
        g["day_rate"] = np.where(g["w"] > 0, g["ws"] / g["w"].where(g["w"] > 0, 1), np.nan)
        return g[["pu_code", "mnc", "day_n", "day_rate"]]


def _field(rng, n_waves: int = 16, length_km: float = 10.0):
    k = rng.normal(0, 1, size=(n_waves, 2))
    k = k / np.linalg.norm(k, axis=1, keepdims=True) * (2 * np.pi / length_km) * rng.uniform(0.5, 1.5, (n_waves, 1))
    ph = rng.uniform(0, 2 * np.pi, n_waves)
    lat0 = (BBOX[1] + BBOX[3]) / 2

    def f(lat, lng):
        y = (np.asarray(lat) - lat0) * 111.0
        x = (np.asarray(lng) - BBOX[0]) * 111.0 * np.cos(np.radians(lat0))
        v = np.cos(np.multiply.outer(x, k[:, 0]) + np.multiply.outer(y, k[:, 1]) + ph).sum(axis=-1)
        return v / np.sqrt(n_waves / 2)

    return f


def _grid(res_deg: float):
    w, s, e, n = BBOX
    nx = int(round((e - w) / res_deg))
    ny = int(round((n - s) / res_deg))
    lng = w + (np.arange(nx) + 0.5) * res_deg
    lat = n - (np.arange(ny) + 0.5) * res_deg
    return np.meshgrid(lat, lng, indexing="ij")


def _gauss(lat_g, lng_g, lat, lng, sigma_m):
    dy = (lat_g - lat) * 111_000.0
    dx = (lng_g - lng) * 111_000.0 * np.cos(np.radians(lat))
    return np.exp(-(dx**2 + dy**2) / (2 * sigma_m**2))


def make_world(seed: int = 7, n_pus: int = 500, dem_res_arcsec: float = 2.0) -> World:
    rng = np.random.default_rng(seed)
    w, s, e, n = BBOX

    # Settlements.
    rows = []
    for kind, count, area, pop in (("Built-up Area", 6, (4e6, 2e7), (3e4, 1.5e5)),
                                   ("Small Settlement Area", 40, (2e5, 1e6), (1e3, 8e3)),
                                   ("Hamlet", 150, (1e4, 5e4), (50, 500))):
        for _ in range(count):
            rows.append((rng.uniform(s + 0.03, n - 0.03), rng.uniform(w + 0.03, e - 0.03), kind,
                         rng.uniform(*area), rng.uniform(*pop)))
    settlements = pd.DataFrame(rows, columns=["lat", "lng", "type", "area_m2", "population"])

    # Terrain: gentle tilt, random hills and two ridges (metres).
    res = dem_res_arcsec / 3600.0
    glat, glng = _grid(res)
    z = 250 + (glat - s) * 300
    for _ in range(30):
        z += rng.uniform(40, 220) * _gauss(glat, glng, rng.uniform(s, n), rng.uniform(w, e), rng.uniform(800, 4000))
    for _ in range(2):
        a, b = rng.uniform(s, n), rng.uniform(-0.8, 0.8)
        d = (glat - (a + b * (glng - w))) * 111_000 / np.sqrt(1 + b * b)
        z += rng.uniform(120, 250) * np.exp(-(d**2) / (2 * 1500.0**2))
    dem = Raster(z.astype("float32"), west=w, north=n, dx=res, dy=res)

    # Population raster (~3 arc-seconds, people per pixel).
    pres = 3.0 / 3600.0
    plat, plng = _grid(pres)
    pop = np.zeros_like(plat)
    for r in settlements.itertuples():
        sig = max(np.sqrt(r.area_m2 / np.pi) / 1.5, 60.0)
        g = _gauss(plat, plng, r.lat, r.lng, sig)
        if g.sum() > 0:
            pop += r.population * g / g.sum()
    population = Raster(pop.astype("float32"), west=w, north=n, dx=pres, dy=pres)

    # Towers: sites near people plus some rural coverage; some shared masts.
    sw = settlements["population"].to_numpy() / settlements["population"].sum()
    cells = []
    shared = []
    for mnc, nsites in SITES_PER_CARRIER.items():
        for j in range(nsites):
            if shared and rng.random() < 0.15:
                la, lo = shared[rng.integers(len(shared))]
            elif rng.random() < 0.65:
                st = settlements.iloc[rng.choice(len(settlements), p=sw)]
                la, lo = offset(st.lat, st.lng, rng.normal(0, 1500), rng.normal(0, 1500))
            else:
                la, lo = rng.uniform(s, n), rng.uniform(w, e)
            la, lo = float(la), float(lo)
            shared.append((la, lo))
            radios = ["GSM"] + [r for r, pr in (("UMTS", 0.5), ("LTE", 0.75 if mnc in (30, 20) else 0.5), ("NR", 0.08))
                                if rng.random() < pr]
            for radio in radios:
                for sector in range(rng.integers(1, 4)):
                    cells.append({
                        "radio": radio, "mcc": C.MCC_NIGERIA, "mnc": mnc, "area": int(1000 + j),
                        "cid": int(mnc * 10_000_000 + j * 100 + 10 * radios.index(radio) + sector),
                        "lat": la + rng.normal(0, 0.00002), "lng": lo + rng.normal(0, 0.00002),
                        "range_m": int(rng.uniform(1000, 8000)), "ocid_samples": int(rng.integers(1, 200)),
                    })
    cells = pd.DataFrame(cells).drop_duplicates(["radio", "mcc", "mnc", "area", "cid"])

    # Polling units: LGAs 02-07 of state 99 (seed.sql already uses LGA 01).
    pus = []
    town_w = np.where(settlements["type"] == "Hamlet", 0.3, 1.0) * np.sqrt(settlements["population"].to_numpy())
    town_w /= town_w.sum()
    lat0 = (s + n) / 2
    for i in range(n_pus):
        if rng.random() < 0.75:
            st = settlements.iloc[rng.choice(len(settlements), p=town_w)]
            spread = np.sqrt(st.area_m2 / np.pi) * 0.8 + 200
            la, lo = offset(st.lat, st.lng, rng.normal(0, spread), rng.normal(0, spread))
        else:
            la, lo = rng.uniform(s + 0.01, n - 0.01), rng.uniform(w + 0.01, e - 0.01)
        la, lo = float(np.clip(la, s + 0.005, n - 0.005)), float(np.clip(lo, w + 0.005, e - 0.005))
        # LGA by sextant of the box, ward by finer grid: admin areas are contiguous.
        lga = 2 + (0 if la >= lat0 else 3) + min(int((lo - w) / (e - w) * 3), 2)
        ward = 1 + min(int((la - s) / (n - s) * 8) % 4 + 4 * (int((lo - w) / (e - w) * 6) % 2), 7)
        pus.append({"lat": la, "lng": lo, "lga_code": lga, "ward_code": ward})
    pus = pd.DataFrame(pus)
    pus["unit"] = pus.groupby(["lga_code", "ward_code"]).cumcount() + 1
    pus["pu_code"] = [f"{STATE_CODE:02d}-{a:02d}-{b:02d}-{c:03d}" for a, b, c in zip(pus["lga_code"], pus["ward_code"], pus["unit"])]
    pus["state_code"] = STATE_CODE
    pus["state"] = STATE_NAME
    pus["lga"] = [f"Synth LGA {a}" for a in pus["lga_code"]]
    pus["ward"] = [f"Synth Ward {a}-{b}" for a, b in zip(pus["lga_code"], pus["ward_code"])]
    pus["name"] = [f"Synthetic Unit {c}" for c in pus["pu_code"]]
    pus["geom_source"] = "inec"
    pus["loc_imputed"] = False

    # Ground truth from the true geometry.
    field_fn = _field(rng)
    geo = compute_features(pus, cells, list(CARRIERS), dem=dem, population=population, settlements=settlements)
    zt = (2.4 + geo["mnc"].map(CARRIER_EFFECT)
          - 1.4 * np.log1p(geo["d1_m"].fillna(50_000) / 1000.0)
          - 0.07 * geo["obs1_m"].fillna(0)
          + 0.6 * geo["share_4g5g_10km"].fillna(0)
          + 0.9 * field_fn(geo["lat"].to_numpy(), geo["lng"].to_numpy())
          - 0.5 * np.minimum(geo["pop_2km"].fillna(0) / 30_000.0, 2.0))
    truth = pd.DataFrame({"pu_code": geo["pu_code"], "mnc": geo["mnc"], "z": zt,
                          "p_true": sigmoid(zt), "p_day": sigmoid(zt + 0.8)})

    # Ookla: crowd tests exist mostly where people are; tile speed tracks the
    # market-share-weighted true quality with noise.
    zu = truth.assign(wt=truth["mnc"].map(MARKET_SHARE)).groupby("pu_code").apply(
        lambda g: float(np.average(g["z"], weights=g["wt"])), include_groups=False)
    tx, ty = lnglat_to_tile(pus["lng"].to_numpy(), pus["lat"].to_numpy(), C.OOKLA_ZOOM)
    urban = (geo[geo["mnc"] == 30]["urban"].fillna(0).to_numpy() > 0)
    orows = []
    quarters = ["2025Q4", "2026Q1", "2026Q2", "2026Q3", "2026Q4"]
    for i, (x, y) in enumerate(zip(tx, ty)):
        base = zu[pus["pu_code"].iat[i]]
        p_has = 0.75 if urban[i] else 0.35
        for qk in tile_neighbourhood(int(x), int(y), C.OOKLA_ZOOM):
            centre = qk == tile_to_quadkey(int(x), int(y), C.OOKLA_ZOOM)
            for q in quarters:
                if rng.random() < (p_has if centre else p_has * 0.3):
                    orows.append({"quadkey": qk, "quarter": q,
                                  "avg_u_kbps": float(np.exp(np.log(2500) + 0.45 * base + rng.normal(0, 0.6))),
                                  "avg_d_kbps": float(np.exp(np.log(12000) + 0.45 * base + rng.normal(0, 0.6))),
                                  "avg_lat_ms": float(np.exp(np.log(60) - 0.1 * base + rng.normal(0, 0.3))),
                                  "tests": int(rng.integers(1, 40)), "devices": int(rng.integers(1, 15))})
    ookla = pd.DataFrame(orows)
    if len(ookla):
        ookla = ookla.groupby(["quadkey", "quarter"], as_index=False).agg(
            avg_u_kbps=("avg_u_kbps", "mean"), avg_d_kbps=("avg_d_kbps", "mean"),
            avg_lat_ms=("avg_lat_ms", "mean"), tests=("tests", "sum"), devices=("devices", "sum"))

    world = World(pus=pus, cells=cells, dem=dem, population=population, settlements=settlements,
                  ookla=ookla, truth=truth, field_fn=field_fn)
    simulate_tests(world, rng, urban)
    return world


def simulate_tests(world: World, rng, urban: np.ndarray, n_devices: int = 60,
                   start: date = date(2026, 10, 1), n_days: int = 40) -> None:
    pus = world.pus
    truth = world.truth.set_index(["pu_code", "mnc"])
    devices = pd.DataFrame({
        "device_id": [str(uuid.UUID(int=int(rng.integers(0, 2**63)) << 64 | i)) for i in range(n_devices)],
        "reputation": rng.uniform(0.4, 0.95, n_devices).round(3),
    })
    mncs = np.array(list(MARKET_SHARE))
    share = np.array(list(MARKET_SHARE.values()))
    tests, sims = [], []
    per_day: dict = {}
    for i, pu in enumerate(pus.itertuples()):
        if rng.random() > (0.45 + 0.3 * urban[i]):
            continue
        n_ev = int(rng.choice([1, 2, 3, 3, 4, 5, 6, 8, 10]))
        devs = rng.choice(n_devices, size=int(rng.integers(1, 4)), replace=False)
        days = rng.choice(n_days, size=int(rng.integers(1, 4)), replace=False)
        plan = [(True, int(rng.choice(devs)), int(rng.choice(days))) for _ in range(n_ev)]
        if rng.random() < 0.5:
            plan += [(False, int(rng.choice(devs)), int(rng.integers(n_days))) for _ in range(int(rng.integers(1, 3)))]
        for evening, d, day in plan:
            key = (d, pu.pu_code, day)
            if per_day.get(key, 0) >= 3:  # the database's daily cap
                continue
            per_day[key] = per_day.get(key, 0) + 1
            hour = rng.uniform(17.0, 23.9) if evening else rng.uniform(8.0, 16.5)
            local = datetime.combine(start + timedelta(days=day), datetime.min.time()) + timedelta(hours=hour)
            captured = (local - timedelta(hours=1)).replace(tzinfo=timezone.utc)
            dist = float(rng.uniform(3, 140))
            place = 1.0 if dist <= 50 else 1.0 - 0.5 * (dist - 50) / 100
            rep = float(devices["reputation"].iat[d])
            tid = str(uuid.UUID(int=int(rng.integers(0, 2**63)) << 64 | len(tests)))
            fl, fg = offset(pu.lat, pu.lng, rng.normal(0, dist / 1.4), rng.normal(0, dist / 1.4))
            tests.append({"test_id": tid, "device_id": devices["device_id"].iat[d], "pu_code": pu.pu_code,
                          "captured_at": captured, "local_date": local.date(), "is_evening": evening,
                          "trust": round(min(1.0, rep * place), 3), "dist_to_pu_m": dist,
                          "acc_m": float(rng.uniform(4, 25)), "geohash7": geohash(float(fl), float(fg), 7)})
            n_sims = 2 if rng.random() < 0.5 else 1
            for slot, mnc in enumerate(rng.choice(mncs, size=n_sims, replace=False, p=share)):
                p = truth.loc[(pu.pu_code, int(mnc)), "p_true" if evening else "p_day"]
                ok_label = rng.random() < p
                if ok_label:
                    total = float(np.clip(np.exp(rng.normal(np.log(90_000), 0.6)), 8_000, 590_000))
                    if rng.random() < 0.03:
                        total = float(rng.uniform(800, 2000))  # implausibly fast: the outlier rule's target
                    upload_ok, err = True, None
                elif rng.random() < 0.6:
                    total, upload_ok, err = None, False, str(rng.choice(["timeout", "no_network", "reset"]))
                else:
                    total, upload_ok, err = float(rng.uniform(600_001, 1_200_000)), True, None
                sims.append({"test_id": tid, "sim_slot": slot, "mcc": C.MCC_NIGERIA, "mnc": int(mnc),
                             "net_type": str(rng.choice(["LTE", "LTE", "HSPA", "EDGE"])), "upload_ok": upload_ok,
                             "total_ms": None if total is None else int(total), "err": err,
                             "latency_ms": [int(x) for x in rng.integers(40, 400, size=3)]})
    world.devices = devices
    world.tests = pd.DataFrame(tests)
    ts = pd.DataFrame(sims)
    ts["total_ms"] = ts["total_ms"].astype("Int64")
    world.test_sims = ts


def world_features(world: World, measured: pd.DataFrame | None = None) -> pd.DataFrame:
    """Feature frame for the synthetic world (as pipeline.build_features would write it)."""
    from .model import unit_evidence

    if measured is None:
        ev = unit_evidence(world.labels())
        measured = ev[ev["measured"]][["pu_code", "mnc", "rate"]]
    return compute_features(world.pus, world.cells, list(CARRIERS), dem=world.dem, population=world.population,
                            settlements=world.settlements, ookla=world.ookla, day=world.day_features(),
                            measured=measured).merge(world.pus[["pu_code", "state_code"]], on="pu_code")
