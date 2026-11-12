import numpy as np

from pos_model.geo import (PointIndex, geohash, haversine_m, lnglat_to_tile, quadkey_to_tile, tile_neighbourhood,
                           tile_to_quadkey)


def test_haversine_one_degree_latitude():
    assert abs(haversine_m(8.0, 4.0, 9.0, 4.0) - 111_195) < 5


def test_point_index_matches_brute_force(rng):
    lat = rng.uniform(8, 9, 300)
    lng = rng.uniform(4, 5, 300)
    qlat, qlng = rng.uniform(8, 9, 20), rng.uniform(4, 5, 20)
    d, i = PointIndex(lat, lng).nearest(qlat, qlng, k=3)
    for j in range(20):
        brute = np.sort(haversine_m(qlat[j], qlng[j], lat, lng))[:3]
        np.testing.assert_allclose(d[j], brute, rtol=1e-9, atol=1e-6)
    cnt = PointIndex(lat, lng).count_within(qlat, qlng, 5000)
    brute_cnt = [(haversine_m(a, b, lat, lng) <= 5000).sum() for a, b in zip(qlat, qlng)]
    assert list(cnt) == brute_cnt


def test_point_index_empty_returns_inf():
    d, i = PointIndex([], []).nearest([8.0], [4.0], k=3)
    assert np.isinf(d).all() and (i == 0).all()


def test_quadkey_known_and_roundtrip():
    assert tile_to_quadkey(3, 5, 3) == "213"  # Bing Maps tile system documentation example
    assert quadkey_to_tile("213") == (3, 5, 3)
    x, y = lnglat_to_tile(4.55, 8.49, 16)
    qk = tile_to_quadkey(int(x), int(y), 16)
    assert len(qk) == 16 and quadkey_to_tile(qk) == (int(x), int(y), 16)
    nb = tile_neighbourhood(int(x), int(y), 16)
    assert len(nb) == 9 and qk in nb and len(set(nb)) == 9


def test_geohash_reference():
    assert geohash(57.64911, 10.40744, 11) == "u4pruydqqvj"  # Wikipedia example
