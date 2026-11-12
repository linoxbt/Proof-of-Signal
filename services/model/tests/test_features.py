import numpy as np
import pandas as pd
import pytest

from pos_model.config import EARTH_RADIUS_M, REFRACTION_K
from pos_model.features import (cells_to_sites, los_obstruction, ookla_features, settlement_features, slope_deg,
                                spatial_context, tower_features)
from pos_model.geo import lnglat_to_tile, offset, tile_to_quadkey
from pos_model.raster import Raster

LAT0, LNG0 = 8.5, 4.6


def flat_dem(z=300.0, res=1 / 3600):
    n = int(0.2 / res)
    return Raster(np.full((n, n), z, dtype="float32"), west=LNG0 - 0.1, north=LAT0 + 0.1, dx=res, dy=res)


def test_cells_collapse_to_sites():
    cells = pd.DataFrame({"mnc": [30, 30, 30, 20], "radio": ["GSM", "LTE", "UMTS", "GSM"],
                          "lat": [8.5, 8.500001, 8.6, 8.5], "lng": [4.6, 4.600001, 4.6, 4.6],
                          "range_m": [1000, 3000, 500, 800]})
    s = cells_to_sites(cells).sort_values(["mnc", "lat"]).reset_index(drop=True)
    assert len(s) == 3
    mtn = s[s["mnc"] == 30].reset_index(drop=True)
    assert mtn.loc[0, "has_4g5g"] and mtn.loc[0, "range_m"] == 3000 and not mtn.loc[1, "has_4g5g"]


def test_tower_distances_and_counts():
    north = [1000, 3000, 7000, 12000]
    lat, lng = offset(np.full(4, LAT0), np.full(4, LNG0), north, 0)
    sites = pd.DataFrame({"mnc": 30, "lat": lat, "lng": lng, "range_m": [900, 1, 1, 1],
                          "has_4g5g": [True, False, False, True]})
    tf = tower_features([LAT0], [LNG0], sites).iloc[0]
    assert abs(tf["d1_m"] - 1000) < 1 and abs(tf["d2_m"] - 3000) < 2 and abs(tf["d3_m"] - 7000) < 3
    assert (tf["n_2km"], tf["n_5km"], tf["n_10km"]) == (1, 2, 3)
    assert tf["range1_m"] == 900 and np.isclose(tf["share_4g5g_10km"], 1 / 3)


def test_tower_features_carrier_without_sites():
    tf = tower_features([LAT0], [LNG0], pd.DataFrame(columns=["mnc", "lat", "lng", "range_m", "has_4g5g"])).iloc[0]
    assert np.isnan(tf["d1_m"]) and tf["n_10km"] == 0 and np.isnan(tf["share_4g5g_10km"])


def test_los_clear_over_flat_ground():
    tl, tg = offset(LAT0, LNG0, 5000, 0)
    assert los_obstruction(flat_dem(), LAT0, LNG0, tl, tg)[0] == 0.0


def test_los_ridge_obstruction_matches_geometry():
    dem = flat_dem(300.0)
    # 100 m wall across the path, 2 km north of the unit; tower 4 km north.
    wall_lat = offset(LAT0, LNG0, 2000, 0)[0]
    rows = np.abs((dem.north - (np.arange(dem.shape[0]) + 0.5) * dem.dy) - wall_lat) < 60 / 111_000
    dem.data[rows, :] = 400.0
    tl, tg = offset(LAT0, LNG0, 4000, 0)
    obs = los_obstruction(dem, LAT0, LNG0, tl, tg)[0]
    line_mid = 300 + 1.5 + (30 - 1.5) * 0.5
    bulge = 2000 * 2000 / (2 * REFRACTION_K * EARTH_RADIUS_M)
    assert abs(obs - (400 + bulge - line_mid)) < 3.0


def test_los_nan_without_dem_coverage():
    tl, tg = offset(LAT0, LNG0, 40_000, 0)  # tower outside the raster
    assert np.isnan(los_obstruction(flat_dem(), LAT0, LNG0, tl, tg)[0])


def test_slope_of_a_plane():
    res = 1 / 3600
    dem = flat_dem(0.0, res)
    lat_c = dem.north - (np.arange(dem.shape[0]) + 0.5) * dem.dy
    dem.data[:] = ((lat_c - LAT0) * np.pi / 180 * EARTH_RADIUS_M * 0.1)[:, None]
    assert abs(slope_deg(dem, [LAT0], [LNG0])[0] - np.degrees(np.arctan(0.1))) < 0.05


def test_ookla_weighted_median_latest_quarters():
    x, y = lnglat_to_tile(LNG0, LAT0, 16)
    qk = tile_to_quadkey(int(x), int(y), 16)
    qe = tile_to_quadkey(int(x) + 1, int(y), 16)
    far = tile_to_quadkey(int(x) + 5, int(y), 16)
    o = pd.DataFrame({
        "quadkey": [qk, qe, qk, far, qk],
        "quarter": ["2026Q1", "2026Q2", "2026Q3", "2026Q4", "2025Q1"],  # 2025Q1 is not among the latest 4
        "avg_u_kbps": [1000.0, 3000.0, 5000.0, 99999.0, 1.0],
        "avg_lat_ms": [50.0, 60.0, 70.0, 1.0, 1.0],
        "tests": [10, 1, 1, 100, 1000],
    })
    f = ookla_features([LAT0], [LNG0], o).iloc[0]
    assert f["ookla_u_kbps"] == 1000.0 and f["ookla_tests"] == 12 and f["ookla_lat_ms"] == 50.0


def test_settlements_builtup_density_population():
    s = pd.DataFrame({"lat": [LAT0, offset(LAT0, LNG0, 800, 0)[0], offset(LAT0, LNG0, 5000, 0)[0]],
                      "lng": [LNG0 + 0.0001, LNG0, LNG0], "type": ["Built-up Area", "Hamlet", "Hamlet"],
                      "area_m2": [np.pi * 500**2, 1e4, 1e4], "population": [30000, 100, 100]})
    f = settlement_features([LAT0, offset(LAT0, LNG0, -3000, 0)[0]], [LNG0, LNG0], s, None)
    assert list(f["builtup"]) == [1.0, 0.0] and list(f["settle_n_1km"]) == [2.0, 0.0]
    assert list(f["pop_2km"]) == [30100.0, 0.0] and list(f["urban"]) == [1.0, 0.0]


def test_population_raster_sum_within():
    res = 3 / 3600
    pop = Raster(np.ones((240, 240), dtype="float32"), west=LNG0 - 0.1, north=LAT0 + 0.1, dx=res, dy=res)
    s = pop.sum_within([LAT0], [LNG0], 2000)[0]
    px = (res * np.pi / 180 * EARTH_RADIUS_M) ** 2 * np.cos(np.radians(LAT0))
    assert abs(s - np.pi * 2000**2 / px) / s < 0.03


def test_spatial_context_excludes_self_and_respects_pool():
    lat = LAT0 + np.arange(8) * 0.01
    t = pd.DataFrame({"pu_code": [f"u{i}" for i in range(8)], "mnc": 30, "lat": lat, "lng": LNG0})
    pool = t.assign(rate=np.arange(8) / 10.0)
    ctx = spatial_context(t, pool, k=2, return_neighbours=True)
    assert ctx.loc[0, "neighbours"] == ["u1", "u2"] and np.isclose(ctx.loc[0, "ctx_rate"], 0.15)
    assert all(f"u{i}" not in ctx.loc[i, "neighbours"] for i in range(8))
    # A pool without u1/u2 (e.g. another CV fold) must not leak them.
    ctx2 = spatial_context(t, pool[~pool["pu_code"].isin(["u1", "u2"])], k=2, return_neighbours=True)
    assert ctx2.loc[0, "neighbours"] == ["u3", "u4"]
    # Other carriers are never neighbours.
    ctx3 = spatial_context(t.assign(mnc=20), pool, k=2)
    assert ctx3["ctx_rate"].isna().all()


@pytest.mark.parametrize("col", ["d1_m", "obs1_m", "ookla_u_kbps", "ctx_rate", "pop_2km", "elev_m"])
def test_world_features_populated(feats, col):
    assert feats[col].notna().mean() > 0.5
