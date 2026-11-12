#!/usr/bin/env python3
"""Copernicus DEM GLO-30 (1 arc-second) tiles for a bbox, mosaicked as a VRT.

Licence: free of charge for any use; required notice: "produced using
Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space
GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all
rights reserved". Source: the AWS open data bucket copernicus-dem-30m (anonymous).

    services/model/.venv/bin/python data/copernicus_dem.py --bbox 4.35 8.25 4.95 8.85
    # -> data/raw/dem/*.tif and data/cache/sources/dem.vrt (read by `pos-model features`)

All of Nigeria (default bbox) is ~120 tiles of ~20-40 MB. Tiles over sea are
absent from the bucket (404) and skipped. Checked 2026-11-12: HEAD on
Copernicus_DSM_COG_10_N08_00_E004_00_DEM.tif answers 200.
"""

from __future__ import annotations

import argparse
import math
import urllib.error
from pathlib import Path
from xml.sax.saxutils import escape

import _common  # noqa: F401
from _common import RAW, SOURCES, download

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"


def tile_name(lat: int, lng: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lng >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lng):03d}_00_DEM"


def tiles_for_bbox(bbox) -> list[str]:
    w, s, e, n = bbox
    return [tile_name(la, lo) for la in range(math.floor(s), math.ceil(n)) for lo in range(math.floor(w), math.ceil(e))]


def write_vrt(tifs: list[Path], dest: Path) -> None:
    """Minimal GDAL VRT mosaic (all tiles share CRS and pixel size at a given latitude band)."""
    import rasterio

    metas = []
    for p in tifs:
        with rasterio.open(p) as src:
            metas.append((p, src.transform, src.width, src.height, src.nodata))
    res_x = min(m[1].a for m in metas)
    res_y = min(-m[1].e for m in metas)
    west = min(m[1].c for m in metas)
    north = max(m[1].f for m in metas)
    east = max(m[1].c + m[2] * m[1].a for m in metas)
    south = min(m[1].f + m[3] * m[1].e for m in metas)
    W = round((east - west) / res_x)
    H = round((north - south) / res_y)
    srcs = []
    for p, t, w, h, nd in metas:
        xoff = round((t.c - west) / res_x)
        yoff = round((north - t.f) / res_y)
        xs = round(w * t.a / res_x)
        ys = round(h * -t.e / res_y)
        srcs.append(f"""    <ComplexSource>
      <SourceFilename relativeToVRT="0">{escape(str(p.resolve()))}</SourceFilename>
      <SourceBand>1</SourceBand>
      <SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}"/>
      <DstRect xOff="{xoff}" yOff="{yoff}" xSize="{xs}" ySize="{ys}"/>
      {f"<NODATA>{nd}</NODATA>" if nd is not None else ""}
    </ComplexSource>""")
    vrt = f"""<VRTDataset rasterXSize="{W}" rasterYSize="{H}">
  <SRS>EPSG:4326</SRS>
  <GeoTransform>{west}, {res_x}, 0, {north}, 0, {-res_y}</GeoTransform>
  <VRTRasterBand dataType="Float32" band="1">
    <NoDataValue>-32767</NoDataValue>
{chr(10).join(srcs)}
  </VRTRasterBand>
</VRTDataset>
"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(vrt)
    print(f"wrote {dest} ({W} x {H} px from {len(tifs)} tiles)")


def main() -> None:
    from pos_model.loaders import NIGERIA_BBOX

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=NIGERIA_BBOX)
    ap.add_argument("--dry-run", action="store_true", help="list tile URLs only")
    a = ap.parse_args()
    got = []
    for name in tiles_for_bbox(a.bbox):
        url = f"{BUCKET}/{name}/{name}.tif"
        if a.dry_run:
            print(url)
            continue
        try:
            got.append(download(url, RAW / "dem" / f"{name}.tif"))
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                print(f"no tile (sea or outside coverage): {name}")
                continue
            raise
    if got:
        write_vrt(got, SOURCES / "dem.vrt")


if __name__ == "__main__":
    main()
