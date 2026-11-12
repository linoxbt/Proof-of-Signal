"""A minimal lon/lat raster (EPSG:4326, north-up) with bilinear sampling.

Copernicus DEM GLO-30 and WorldPop/GRID3 population rasters are distributed in
EPSG:4326, so no reprojection is needed. Large mosaics (a VRT of DEM tiles)
are read through a window around the area being processed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Raster:
    data: np.ndarray  # float array, NaN for nodata; row 0 is the northern edge
    west: float
    north: float
    dx: float  # degrees per column (> 0)
    dy: float  # degrees per row (> 0, rows go south)

    @property
    def shape(self):
        return self.data.shape

    @property
    def bounds(self):
        h, w = self.data.shape
        return self.west, self.north - h * self.dy, self.west + w * self.dx, self.north

    def _rowcol(self, lat, lng):
        col = (np.asarray(lng, dtype=float) - self.west) / self.dx - 0.5
        row = (self.north - np.asarray(lat, dtype=float)) / self.dy - 0.5
        return row, col

    def sample(self, lat, lng) -> np.ndarray:
        """Bilinear interpolation at pixel centres; NaN outside the raster."""
        row, col = self._rowcol(lat, lng)
        h, w = self.data.shape
        out = np.full(np.shape(row), np.nan)
        inside = (row >= -0.5) & (row <= h - 0.5) & (col >= -0.5) & (col <= w - 0.5)
        if not np.any(inside):
            return out
        r = np.clip(row[inside], 0, h - 1)
        c = np.clip(col[inside], 0, w - 1)
        r0 = np.clip(np.floor(r).astype(int), 0, max(h - 2, 0))
        c0 = np.clip(np.floor(c).astype(int), 0, max(w - 2, 0))
        r1 = np.minimum(r0 + 1, h - 1)
        c1 = np.minimum(c0 + 1, w - 1)
        fr = r - r0
        fc = c - c0
        d = self.data
        v = (
            d[r0, c0] * (1 - fr) * (1 - fc)
            + d[r0, c1] * (1 - fr) * fc
            + d[r1, c0] * fr * (1 - fc)
            + d[r1, c1] * fr * fc
        )
        out[inside] = v
        return out

    def sum_within(self, lat, lng, radius_m: float) -> np.ndarray:
        """Sum of pixels whose centres lie within radius_m of each point (NaN pixels count 0)."""
        from .geo import R

        lat = np.atleast_1d(np.asarray(lat, dtype=float))
        lng = np.atleast_1d(np.asarray(lng, dtype=float))
        h, w = self.data.shape
        data = np.nan_to_num(self.data, nan=0.0)
        out = np.full(len(lat), np.nan)
        rad_lat = np.degrees(radius_m / R)
        for i, (la, lo) in enumerate(zip(lat, lng)):
            rad_lng = rad_lat / max(np.cos(np.radians(la)), 1e-6)
            r_lo = int(np.floor((self.north - (la + rad_lat)) / self.dy))
            r_hi = int(np.ceil((self.north - (la - rad_lat)) / self.dy))
            c_lo = int(np.floor((lo - rad_lng - self.west) / self.dx))
            c_hi = int(np.ceil((lo + rad_lng - self.west) / self.dx))
            if r_hi < 0 or c_hi < 0 or r_lo >= h or c_lo >= w:
                continue
            r_lo, c_lo = max(r_lo, 0), max(c_lo, 0)
            r_hi, c_hi = min(r_hi, h - 1), min(c_hi, w - 1)
            rows = np.arange(r_lo, r_hi + 1)
            cols = np.arange(c_lo, c_hi + 1)
            plat = self.north - (rows + 0.5) * self.dy
            plng = self.west + (cols + 0.5) * self.dx
            dn = (plat - la)[:, None] * np.pi / 180 * R
            de = (plng - lo)[None, :] * np.pi / 180 * R * np.cos(np.radians(la))
            mask = dn**2 + de**2 <= radius_m**2
            out[i] = float(data[np.ix_(rows, cols)][mask].sum())
        return out

    # --- I/O --------------------------------------------------------------

    @classmethod
    def from_file(cls, path: str | Path, bbox: tuple[float, float, float, float] | None = None) -> "Raster":
        """Read a GeoTIFF/VRT in EPSG:4326, optionally only the window covering bbox (w, s, e, n)."""
        import rasterio
        from rasterio.windows import from_bounds

        with rasterio.open(path) as src:
            if src.crs is not None and src.crs.to_epsg() not in (4326, None):
                raise ValueError(f"{path}: expected EPSG:4326, got {src.crs}")
            t = src.transform
            if t.b != 0 or t.d != 0 or t.e >= 0:
                raise ValueError(f"{path}: raster must be north-up without rotation")
            if bbox is not None:
                win = from_bounds(*bbox, transform=t).round_offsets().round_lengths()
                win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            else:
                win = rasterio.windows.Window(0, 0, src.width, src.height)
            arr = src.read(1, window=win, masked=True).astype("float32").filled(np.nan)
            wt = src.window_transform(win)
        return cls(arr, west=wt.c, north=wt.f, dx=wt.a, dy=-wt.e)

    def to_file(self, path: str | Path) -> None:
        import rasterio
        from rasterio.transform import from_origin

        Path(path).parent.mkdir(parents=True, exist_ok=True)
        h, w = self.data.shape
        with rasterio.open(
            path, "w", driver="GTiff", height=h, width=w, count=1, dtype="float32",
            crs="EPSG:4326", transform=from_origin(self.west, self.north, self.dx, self.dy),
            nodata=np.nan, compress="deflate",
        ) as dst:
            dst.write(self.data.astype("float32"), 1)
