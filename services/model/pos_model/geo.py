"""Small, dependency-light geodesy helpers (WGS84 lon/lat in degrees, metres)."""

from __future__ import annotations

import math

import numpy as np
from scipy.spatial import cKDTree

from .config import EARTH_RADIUS_M

R = EARTH_RADIUS_M


def haversine_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres; broadcasts over numpy arrays."""
    lat1, lng1, lat2, lng2 = (np.radians(np.asarray(a, dtype=float)) for a in (lat1, lng1, lat2, lng2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def to_xyz(lat, lng) -> np.ndarray:
    lat = np.radians(np.asarray(lat, dtype=float))
    lng = np.radians(np.asarray(lng, dtype=float))
    return np.column_stack([R * np.cos(lat) * np.cos(lng), R * np.cos(lat) * np.sin(lng), R * np.sin(lat)])


def chord_to_arc(c):
    return 2 * R * np.arcsin(np.clip(np.asarray(c, dtype=float) / (2 * R), 0, 1))


def arc_to_chord(d):
    return 2 * R * np.sin(np.asarray(d, dtype=float) / (2 * R))


class PointIndex:
    """KD-tree over 3-D chord coordinates, so distances are exact great-circle distances."""

    def __init__(self, lat, lng):
        self.n = len(np.asarray(lat))
        self.tree = cKDTree(to_xyz(lat, lng)) if self.n else None

    def nearest(self, lat, lng, k: int):
        """Distances (m) and indices of the k nearest points; inf / n where fewer exist."""
        m = len(np.asarray(lat))
        if self.tree is None or m == 0:
            return np.full((m, k), np.inf), np.full((m, k), self.n, dtype=int)
        d, i = self.tree.query(to_xyz(lat, lng), k=k)
        d = np.asarray(d, dtype=float).reshape(m, k)
        i = np.asarray(i).reshape(m, k)
        finite = np.isfinite(d)
        d[finite] = chord_to_arc(d[finite])
        return d, i

    def count_within(self, lat, lng, radius_m: float) -> np.ndarray:
        m = len(np.asarray(lat))
        if self.tree is None or m == 0:
            return np.zeros(m, dtype=int)
        return np.asarray(
            self.tree.query_ball_point(to_xyz(lat, lng), r=float(arc_to_chord(radius_m)), return_length=True),
            dtype=int,
        )

    def within(self, lat, lng, radius_m: float):
        if self.tree is None:
            return [[] for _ in range(len(np.asarray(lat)))]
        return self.tree.query_ball_point(to_xyz(lat, lng), r=float(arc_to_chord(radius_m)))


# --- Web Mercator tiles (Ookla open data uses zoom-16 quadkeys) -------------

def lnglat_to_tile(lng, lat, zoom: int):
    lat = np.clip(np.asarray(lat, dtype=float), -85.05112878, 85.05112878)
    lng = np.asarray(lng, dtype=float)
    n = 2 ** zoom
    x = np.floor((lng + 180.0) / 360.0 * n).astype(np.int64)
    lat_r = np.radians(lat)
    y = np.floor((1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n).astype(np.int64)
    return np.clip(x, 0, n - 1), np.clip(y, 0, n - 1)


def tile_to_quadkey(x: int, y: int, zoom: int) -> str:
    digits = []
    for i in range(zoom, 0, -1):
        mask = 1 << (i - 1)
        d = (1 if x & mask else 0) + (2 if y & mask else 0)
        digits.append(str(d))
    return "".join(digits)


def quadkey_to_tile(qk: str) -> tuple[int, int, int]:
    x = y = 0
    z = len(qk)
    for i, ch in enumerate(qk):
        mask = 1 << (z - i - 1)
        d = int(ch)
        if d & 1:
            x |= mask
        if d & 2:
            y |= mask
    return x, y, z


def tile_bounds(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees."""
    n = 2 ** zoom

    def lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360.0 - 180.0, lat(y + 1), (x + 1) / n * 360.0 - 180.0, lat(y)


def tile_neighbourhood(x: int, y: int, zoom: int) -> list[str]:
    """Quadkeys of the tile and its 8 neighbours."""
    n = 2 ** zoom
    out = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            xx, yy = x + dx, y + dy
            if 0 <= xx < n and 0 <= yy < n:
                out.append(tile_to_quadkey(xx, yy, zoom))
    return out


# --- Geohash (tests.geohash7) ------------------------------------------------

_GH32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lng: float, precision: int = 7) -> str:
    lat_lo, lat_hi, lng_lo, lng_hi = -90.0, 90.0, -180.0, 180.0
    bits, bit, ch, even, out = 0, 0, 0, True, []
    while len(out) < precision:
        if even:
            mid = (lng_lo + lng_hi) / 2
            if lng > mid:
                ch |= 1 << (4 - bit)
                lng_lo = mid
            else:
                lng_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat > mid:
                ch |= 1 << (4 - bit)
                lat_lo = mid
            else:
                lat_hi = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_GH32[ch])
            bit, ch = 0, 0
        bits += 1
    return "".join(out)


def offset(lat, lng, north_m, east_m):
    """Move a point by small metric offsets (equirectangular, fine below ~50 km)."""
    lat = np.asarray(lat, dtype=float)
    lng = np.asarray(lng, dtype=float)
    dlat = np.degrees(np.asarray(north_m, dtype=float) / R)
    dlng = np.degrees(np.asarray(east_m, dtype=float) / (R * np.cos(np.radians(lat))))
    return lat + dlat, lng + dlng
