#!/usr/bin/env python3
"""GRID3 settlement extents and gridded population for Nigeria.

Licences:
  GRID3 NGA Settlement Extents v3.1 (CIESIN / GRID3, via HDX): CC BY-SA 4.0.
  WorldPop NGA 2020 constrained, UN-adjusted population (100 m): CC BY 4.0.
  (GRID3's own NGA gridded population is published through WorldPop's WOPR
  portal; pass --population-url to use it or a newer release instead.)

    services/model/.venv/bin/python data/grid3.py download        # ~736 MB + ~62 MB
    services/model/.venv/bin/python data/grid3.py build           # -> data/cache/sources/{settlements.parquet,population.tif}

Checked 2026-11-12: HDX CKAN package `grid3-nga-settlement-extents-v3_1` lists the
GeoPackage zip below (735,773,991 bytes, CC BY-SA); the WorldPop URL answers 200
(61,515,004 bytes). The type field of extents is "Built-up Area" / "Small
Settlement Area" / "Hamlet"; the loader matches the type and population
columns by name and stops with the column list if they differ.
"""

from __future__ import annotations

import argparse
import json
import shutil
import urllib.request
import zipfile

import _common  # noqa: F401
from _common import RAW, SOURCES, download

HDX_PACKAGE = "https://data.humdata.org/api/3/action/package_show?id=grid3-nga-settlement-extents-v3_1"
EXTENTS_URL = ("https://data.humdata.org/dataset/af838671-b9a6-4ae9-8ed5-eea750b05597/resource/"
               "0a22d6fc-7f1f-4f50-aead-09ef7be0455d/download/grid3_nga_settlement_extents_v3_1_gpkg.zip")
POPULATION_URL = ("https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/2020/maxar_v1/NGA/"
                  "nga_ppp_2020_UNadj_constrained.tif")


def resolve_extents_url() -> str:
    """Prefer the URL HDX lists now (resource URLs change between releases)."""
    try:
        with urllib.request.urlopen(HDX_PACKAGE, timeout=60) as r:
            pkg = json.load(r)["result"]
        for res in pkg["resources"]:
            if "settlement_extents" in res["url"] and res["url"].endswith("gpkg.zip"):
                return res["url"]
    except Exception as e:  # network or schema change: fall back to the pinned URL
        print(f"HDX lookup failed ({e}); using pinned URL")
    return EXTENTS_URL


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download")
    d.add_argument("--population-url", default=POPULATION_URL)
    b = sub.add_parser("build")
    b.add_argument("--layer", help="GeoPackage layer (default: first)")
    a = ap.parse_args()
    if a.cmd == "download":
        z = download(resolve_extents_url(), RAW / "grid3" / "settlement_extents_gpkg.zip")
        with zipfile.ZipFile(z) as zf:
            zf.extractall(RAW / "grid3")
        download(a.population_url, RAW / "grid3" / "population.tif")
    else:
        from pos_model.loaders import settlements_from_gpkg

        gpkg = sorted((RAW / "grid3").rglob("*.gpkg"))
        if not gpkg:
            raise SystemExit("no .gpkg under data/raw/grid3; run download first")
        df = settlements_from_gpkg(gpkg[0], a.layer)
        SOURCES.mkdir(parents=True, exist_ok=True)
        df.to_parquet(SOURCES / "settlements.parquet", index=False)
        print(f"wrote {len(df)} settlements; types: {df['type'].value_counts().to_dict()}")
        shutil.copyfile(RAW / "grid3" / "population.tif", SOURCES / "population.tif")
        print(f"copied population raster to {SOURCES / 'population.tif'}")


if __name__ == "__main__":
    main()
