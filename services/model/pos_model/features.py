"""Feature construction per (polling unit, carrier).

Pure functions over pandas frames and rasters, so they run the same on the
synthetic world (tests, demo) and on real downloaded sources. Database I/O is
in pipeline.py.

Feature groups (spec: "Coverage model"):
  towers      d1_m, d2_m, d3_m        distance to the 1st/2nd/3rd nearest site of the carrier
              n_2km, n_5km, n_10km   sites of the carrier within 2/5/10 km
              share_4g5g_10km        share of those sites (10 km) with an LTE or NR cell
              range1_m               OpenCellID range of the nearest site
  terrain     elev_m, slope_deg      Copernicus DEM GLO-30 at the unit
              obs1_m, obs2_m, obs3_m line-of-sight obstruction to the 3 nearest sites
  settlement  builtup, settle_n_1km, pop_2km, urban (GRID3 extents, gridded population)
  crowd QoS   ookla_u_kbps, ookla_lat_ms, ookla_tests (zoom-16 tile + 8 neighbours, latest 4 quarters)
  daytime     day_n, day_rate        accepted daytime tests at the unit on this carrier (features, never labels)
  context     ctx_rate, ctx_dist_m   mean measured success of the 5 nearest other measured units on
                                     the same carrier, and their mean distance (out-of-fold in training)
  admin       is_state_XX one-hots, loc_imputed
  carrier     mnc (categorical)
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from . import config as C
from .geo import PointIndex, haversine_m, lnglat_to_tile, tile_neighbourhood
from .raster import Raster

log = logging.getLogger(__name__)

TOWER_COLS = ["d1_m", "d2_m", "d3_m", "n_2km", "n_5km", "n_10km", "share_4g5g_10km", "range1_m"]
TERRAIN_COLS = ["elev_m", "slope_deg", "obs1_m", "obs2_m", "obs3_m"]
SETTLEMENT_COLS = ["builtup", "settle_n_1km", "pop_2km", "urban"]
OOKLA_COLS = ["ookla_u_kbps", "ookla_lat_ms", "ookla_tests"]
DAY_COLS = ["day_n", "day_rate"]
CONTEXT_COLS = ["ctx_rate", "ctx_dist_m"]
BASE_COLS = TOWER_COLS + TERRAIN_COLS + SETTLEMENT_COLS + OOKLA_COLS + DAY_COLS + CONTEXT_COLS + ["loc_imputed"]

# Success may not rise as the nearest towers get farther or the path more obstructed.
MONOTONE_DECREASING = ["d1_m", "d2_m", "d3_m", "obs1_m", "obs2_m", "obs3_m"]


# --- towers ------------------------------------------------------------------

def cells_to_sites(cells: pd.DataFrame) -> pd.DataFrame:
    """Collapse co-located cells (sectors, radios) of one carrier into sites."""
    if cells.empty:
        return pd.DataFrame(columns=["mnc", "lat", "lng", "range_m", "has_4g5g"])
    c = cells.dropna(subset=["lat", "lng"]).copy()
    c["klat"] = c["lat"].round(C.SITE_DEDUPE_DECIMALS)
    c["klng"] = c["lng"].round(C.SITE_DEDUPE_DECIMALS)
    c["is45"] = c["radio"].isin(["LTE", "NR"])
    g = c.groupby(["mnc", "klat", "klng"], as_index=False).agg(
        lat=("lat", "mean"), lng=("lng", "mean"), range_m=("range_m", "max"), has_4g5g=("is45", "any")
    )
    return g[["mnc", "lat", "lng", "range_m", "has_4g5g"]]


def tower_features(lat, lng, sites: pd.DataFrame) -> pd.DataFrame:
    """Tower features for points against one carrier's sites. Also returns the
    3 nearest site coordinates (t{k}_lat/t{k}_lng) for the line-of-sight step."""
    lat = np.asarray(lat, dtype=float)
    lng = np.asarray(lng, dtype=float)
    m = len(lat)
    out = pd.DataFrame(index=range(m))
    idx = PointIndex(sites["lat"].to_numpy(), sites["lng"].to_numpy())
    d, i = idx.nearest(lat, lng, k=3)
    slat = np.append(sites["lat"].to_numpy(dtype=float), np.nan)
    slng = np.append(sites["lng"].to_numpy(dtype=float), np.nan)
    srange = np.append(pd.to_numeric(sites["range_m"], errors="coerce").to_numpy(dtype=float), np.nan)
    for k in range(3):
        dk = d[:, k].copy()
        dk[~np.isfinite(dk)] = np.nan
        out[f"d{k + 1}_m"] = dk
        out[f"t{k + 1}_lat"] = slat[i[:, k]]
        out[f"t{k + 1}_lng"] = slng[i[:, k]]
    out["range1_m"] = srange[i[:, 0]]
    for r in C.TOWER_COUNT_RADII_M:
        out[f"n_{r // 1000}km"] = idx.count_within(lat, lng, r)
    has45 = sites["has_4g5g"].to_numpy(dtype=bool) if len(sites) else np.zeros(0, bool)
    share = np.full(m, np.nan)
    for j, nb in enumerate(idx.within(lat, lng, 10_000)):
        if len(nb):
            share[j] = has45[nb].mean()
    out["share_4g5g_10km"] = share
    return out


# --- terrain -----------------------------------------------------------------

def slope_deg(dem: Raster, lat, lng, h_m: float = 30.0) -> np.ndarray:
    """Slope from central differences of the DEM sampled ±h_m east/north of each point."""
    from .geo import offset

    lat = np.asarray(lat, dtype=float)
    lng = np.asarray(lng, dtype=float)
    ln, gn = offset(lat, lng, h_m, 0)
    ls, gs = offset(lat, lng, -h_m, 0)
    le, ge = offset(lat, lng, 0, h_m)
    lw, gw = offset(lat, lng, 0, -h_m)
    dzdn = (dem.sample(ln, gn) - dem.sample(ls, gs)) / (2 * h_m)
    dzde = (dem.sample(le, ge) - dem.sample(lw, gw)) / (2 * h_m)
    return np.degrees(np.arctan(np.hypot(dzdn, dzde)))


def los_obstruction(dem: Raster, lat0, lng0, lat1, lng1,
                    h0: float = C.PU_ANTENNA_M, h1: float = C.TOWER_ANTENNA_M,
                    step_m: float = C.LOS_STEP_M, max_samples: int = C.LOS_MAX_SAMPLES,
                    chunk: int = 4_000_000) -> np.ndarray:
    """Maximum rise of the ground (plus Earth bulge at k=4/3) above the straight
    line from the unit (h0 above ground) to the tower (h1 above ground),
    sampled every step_m metres. 0 for a clear path, NaN where the DEM or a
    tower is missing."""
    lat0, lng0, lat1, lng1 = (np.atleast_1d(np.asarray(a, dtype=float)) for a in (lat0, lng0, lat1, lng1))
    m = len(lat0)
    out = np.full(m, np.nan)
    D = haversine_m(lat0, lng0, lat1, lng1)
    z0 = dem.sample(lat0, lng0) + h0
    z1 = dem.sample(lat1, lng1) + h1
    ok = np.isfinite(D) & np.isfinite(z0) & np.isfinite(z1)
    step = np.maximum(step_m, D / max_samples)
    n = np.where(ok, np.floor(D / step).astype(np.int64), 0)
    n = np.where(ok & (n * step >= D), n - 1, n)  # samples strictly between the ends
    n = np.maximum(n, 0)
    out[ok & (n == 0)] = 0.0
    todo = np.flatnonzero(ok & (n > 0))
    kR2 = 2 * C.REFRACTION_K * C.EARTH_RADIUS_M
    start = 0
    while start < len(todo):
        # Grow the chunk until it holds ~chunk samples.
        cs = np.cumsum(n[todo[start:]])
        stop = start + max(1, int(np.searchsorted(cs, chunk, side="right")))
        sel = todo[start:stop]
        start = stop
        cnt = n[sel]
        grp = np.repeat(np.arange(len(sel)), cnt)
        first = np.concatenate([[0], np.cumsum(cnt)[:-1]])
        j = np.arange(cnt.sum()) - np.repeat(first, cnt) + 1
        s = j * step[sel][grp]
        Dg = D[sel][grp]
        f = s / Dg
        la = lat0[sel][grp] + (lat1[sel][grp] - lat0[sel][grp]) * f
        lo = lng0[sel][grp] + (lng1[sel][grp] - lng0[sel][grp]) * f
        g = dem.sample(la, lo)
        line = z0[sel][grp] + (z1[sel][grp] - z0[sel][grp]) * f
        rise = g + s * (Dg - s) / kR2 - line
        valid = np.isfinite(rise)
        rise = np.where(valid, rise, -np.inf)
        mx = np.maximum.reduceat(rise, first)
        any_valid = np.add.reduceat(valid.astype(np.int64), first) > 0
        out[sel] = np.where(any_valid, np.maximum(mx, 0.0), np.nan)
    return out


# --- settlements, population, crowd QoS ------------------------------------

def settlement_features(lat, lng, settlements: pd.DataFrame | None, population: Raster | None) -> pd.DataFrame:
    lat = np.asarray(lat, dtype=float)
    lng = np.asarray(lng, dtype=float)
    m = len(lat)
    out = pd.DataFrame(index=range(m))
    if settlements is not None and len(settlements):
        idx = PointIndex(settlements["lat"].to_numpy(), settlements["lng"].to_numpy())
        out["settle_n_1km"] = idx.count_within(lat, lng, C.SETTLEMENT_RADIUS_M).astype(float)
        stype = settlements["type"].astype(str).str.lower()
        bua = settlements[stype.str.contains("built") | (stype == "bua")]
        builtup = np.zeros(m)
        if len(bua):
            # Inside a built-up extent, approximated by the circle of equal area
            # around its centroid (the loader keeps centroid + area only).
            radius = np.sqrt(bua["area_m2"].to_numpy(dtype=float) / np.pi)
            bidx = PointIndex(bua["lat"].to_numpy(), bua["lng"].to_numpy())
            d, i = bidx.nearest(lat, lng, k=min(5, len(bua)))
            rr = np.append(radius, 0.0)[i]
            builtup = (d <= rr).any(axis=1).astype(float)
        out["builtup"] = builtup
    else:
        out["settle_n_1km"] = np.nan
        out["builtup"] = np.nan
    if population is not None:
        out["pop_2km"] = population.sum_within(lat, lng, C.POPULATION_RADIUS_M)
    elif settlements is not None and "population" in settlements and len(settlements):
        idx = PointIndex(settlements["lat"].to_numpy(), settlements["lng"].to_numpy())
        popv = settlements["population"].fillna(0).to_numpy(dtype=float)
        out["pop_2km"] = [popv[nb].sum() for nb in idx.within(lat, lng, C.POPULATION_RADIUS_M)]
    else:
        out["pop_2km"] = np.nan
    urban = (out["builtup"] == 1) | (out["pop_2km"] >= C.URBAN_POP_2KM)
    out["urban"] = np.where(out["builtup"].isna() & out["pop_2km"].isna(), np.nan, urban.astype(float))
    return out[SETTLEMENT_COLS]


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    ok = np.isfinite(values) & np.isfinite(weights) & (weights > 0)
    if not ok.any():
        return np.nan
    v, w = values[ok], weights[ok]
    o = np.argsort(v)
    v, w = v[o], w[o]
    cw = np.cumsum(w)
    return float(v[np.searchsorted(cw, 0.5 * cw[-1])])


def latest_quarters(ookla: pd.DataFrame, n: int = C.OOKLA_QUARTERS) -> pd.DataFrame:
    qs = sorted(ookla["quarter"].astype(str).unique())[-n:]
    return ookla[ookla["quarter"].astype(str).isin(qs)]


def ookla_features(lat, lng, ookla: pd.DataFrame | None) -> pd.DataFrame:
    """Test-weighted median upload (kbps) and latency over the zoom-16 tile of
    each point and its 8 neighbours, latest 4 quarters; plus the test count.
    Ookla publishes per-tile averages (avg_u_kbps), so this is a median of tile
    averages weighted by tests."""
    lat = np.asarray(lat, dtype=float)
    lng = np.asarray(lng, dtype=float)
    m = len(lat)
    out = pd.DataFrame({"ookla_u_kbps": np.nan, "ookla_lat_ms": np.nan, "ookla_tests": 0.0}, index=range(m))
    if ookla is None or ookla.empty or m == 0:
        if ookla is None:
            out["ookla_tests"] = np.nan
        return out
    o = latest_quarters(ookla)
    x, y = lnglat_to_tile(lng, lat, C.OOKLA_ZOOM)
    rows = [(i, qk) for i, (xx, yy) in enumerate(zip(x, y)) for qk in tile_neighbourhood(int(xx), int(yy), C.OOKLA_ZOOM)]
    nb = pd.DataFrame(rows, columns=["i", "quadkey"])
    j = nb.merge(o[["quadkey", "avg_u_kbps", "avg_lat_ms", "tests"]], on="quadkey", how="inner")
    if j.empty:
        return out
    for i, g in j.groupby("i"):
        w = g["tests"].to_numpy(dtype=float)
        out.at[i, "ookla_u_kbps"] = _weighted_median(g["avg_u_kbps"].to_numpy(dtype=float), w)
        out.at[i, "ookla_lat_ms"] = _weighted_median(g["avg_lat_ms"].to_numpy(dtype=float), w)
        out.at[i, "ookla_tests"] = float(w.sum())
    return out


# --- spatial context ---------------------------------------------------------

def spatial_context(targets: pd.DataFrame, pool: pd.DataFrame, k: int = C.CONTEXT_K,
                    return_neighbours: bool = False) -> pd.DataFrame:
    """Mean measured success rate of the k nearest *other* measured units on
    the same carrier, and the mean distance to them.

    targets: pu_code, mnc, lat, lng.  pool: pu_code, mnc, lat, lng, rate.
    The caller decides which units are in the pool; for out-of-fold features
    the pool holds only units outside the target's validation fold.
    return_neighbours adds a `neighbours` column (list of pool pu_codes used)."""
    out = pd.DataFrame({"ctx_rate": np.nan, "ctx_dist_m": np.nan}, index=targets.index)
    if return_neighbours:
        out["neighbours"] = [[] for _ in range(len(out))]
    for mnc, tg in targets.groupby("mnc"):
        pl = pool[pool["mnc"] == mnc]
        if pl.empty:
            continue
        kk = min(k + 1, len(pl))
        idx = PointIndex(pl["lat"].to_numpy(), pl["lng"].to_numpy())
        d, i = idx.nearest(tg["lat"].to_numpy(), tg["lng"].to_numpy(), k=kk)
        codes = np.append(pl["pu_code"].to_numpy(), None)[i]
        rates = np.append(pl["rate"].to_numpy(dtype=float), np.nan)[i]
        self_hit = codes == tg["pu_code"].to_numpy()[:, None]
        keep = ~self_hit & np.isfinite(d)
        # First k non-self neighbours per row.
        rank = np.cumsum(keep, axis=1)
        keep &= rank <= k
        cnt = keep.sum(axis=1)
        with np.errstate(invalid="ignore"):
            r = np.where(cnt > 0, np.where(keep, rates, 0).sum(axis=1) / np.maximum(cnt, 1), np.nan)
            dd = np.where(cnt > 0, np.where(keep, d, 0).sum(axis=1) / np.maximum(cnt, 1), np.nan)
        out.loc[tg.index, "ctx_rate"] = r
        out.loc[tg.index, "ctx_dist_m"] = dd
        if return_neighbours:
            for row, idx_ in enumerate(tg.index):
                out.at[idx_, "neighbours"] = codes[row][keep[row]].tolist()
    return out


# --- assembly ----------------------------------------------------------------

def compute_features(
    pus: pd.DataFrame,
    cells: pd.DataFrame,
    carriers: list[int],
    dem: Raster | None = None,
    population: Raster | None = None,
    settlements: pd.DataFrame | None = None,
    ookla: pd.DataFrame | None = None,
    day: pd.DataFrame | None = None,
    measured: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """One row per (unit, carrier).

    pus: pu_code, lat, lng, state_code, loc_imputed.   cells: mnc, radio, lat, lng, range_m.
    day: pu_code, mnc, day_n, day_rate.   measured: pu_code, mnc, rate (pool for ctx_*)."""
    pus = pus.reset_index(drop=True)
    lat = pus["lat"].to_numpy(dtype=float)
    lng = pus["lng"].to_numpy(dtype=float)
    unit = pd.DataFrame({"pu_code": pus["pu_code"], "lat": lat, "lng": lng})
    unit["loc_imputed"] = pus.get("loc_imputed", pd.Series(False, index=pus.index)).astype(float).to_numpy()
    if dem is not None:
        unit["elev_m"] = dem.sample(lat, lng)
        unit["slope_deg"] = slope_deg(dem, lat, lng)
    else:
        unit["elev_m"] = np.nan
        unit["slope_deg"] = np.nan
    unit = pd.concat([unit, settlement_features(lat, lng, settlements, population),
                      ookla_features(lat, lng, ookla)], axis=1)
    for s in sorted(pus["state_code"].dropna().astype(int).unique()):
        unit[f"is_state_{s:02d}"] = (pus["state_code"].to_numpy() == s).astype(float)

    sites = cells_to_sites(cells)
    parts = []
    for mnc in carriers:
        tw = tower_features(lat, lng, sites[sites["mnc"] == mnc])
        for k in (1, 2, 3):
            if dem is not None:
                tw[f"obs{k}_m"] = los_obstruction(dem, lat, lng, tw[f"t{k}_lat"], tw[f"t{k}_lng"])
            else:
                tw[f"obs{k}_m"] = np.nan
        tw = tw.drop(columns=[c for c in tw.columns if c.startswith("t") and c[1].isdigit()])
        part = pd.concat([unit.reset_index(drop=True), tw], axis=1)
        part["mnc"] = int(mnc)
        parts.append(part)
    f = pd.concat(parts, ignore_index=True)

    return add_day_and_context(f, day, measured)


def add_day_and_context(f: pd.DataFrame, day: pd.DataFrame | None, measured: pd.DataFrame | None) -> pd.DataFrame:
    """Join daytime-test features and the (deployment) spatial context.
    f needs pu_code, mnc, lat, lng."""
    f = f.drop(columns=[c for c in DAY_COLS + CONTEXT_COLS if c in f.columns])
    if day is not None and len(day):
        f = f.merge(day[["pu_code", "mnc", "day_n", "day_rate"]], on=["pu_code", "mnc"], how="left")
        f["day_n"] = f["day_n"].fillna(0).astype(float)
    else:
        f["day_n"] = 0.0
        f["day_rate"] = np.nan
    if measured is not None and len(measured):
        units = f[["pu_code", "lat", "lng"]].drop_duplicates("pu_code")
        pool = measured.merge(units, on="pu_code", how="inner")
        f[CONTEXT_COLS] = spatial_context(f[["pu_code", "mnc", "lat", "lng"]], pool)
    else:
        f["ctx_rate"] = np.nan
        f["ctx_dist_m"] = np.nan
    return f


def feature_columns(frame: pd.DataFrame) -> list[str]:
    states = sorted(c for c in frame.columns if c.startswith("is_state_"))
    return BASE_COLS + states + ["mnc"]


def to_vectors(frame: pd.DataFrame) -> list[dict]:
    """JSON-safe dicts for features.vector (NaN -> null)."""
    cols = [c for c in feature_columns(frame) if c != "mnc"] + ["lat", "lng"]
    recs = []
    for row in frame[cols].itertuples(index=False):
        recs.append({c: (None if v is None or (isinstance(v, float) and not np.isfinite(v)) else float(v))
                     for c, v in zip(cols, row)})
    return recs
