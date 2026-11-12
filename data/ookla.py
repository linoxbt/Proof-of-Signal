#!/usr/bin/env python3
"""Ookla Speedtest open data, mobile performance tiles (zoom-16 quadkeys) for Nigeria.

Licence: CC BY-NC-SA 4.0 (https://github.com/teamookla/ookla-open-data).
NON-COMMERCIAL use only; attribute "Speedtest by Ookla Global Fixed and Mobile
Network Performance Maps"; derived data shares alike. Do not use this source in
any commercial product built on Proof of Signal.

Reads the public bucket anonymously over HTTPS with DuckDB httpfs (the s3://
path would pick up any AWS credentials in the environment), keeping only tiles
whose centroid (tile_x, tile_y) lies in the bbox, so only Nigeria's rows are
written. Each quarterly file is a few hundred MB of which DuckDB reads the
needed columns.

    services/model/.venv/bin/python data/ookla.py download --quarters 4
    services/model/.venv/bin/python data/ookla.py build     # -> data/cache/sources/ookla_mobile.parquet

Checked 2026-11-12: bucket listing works anonymously; 2025 Q1-Q4 files exist;
schema quadkey, tile, tile_x, tile_y, avg_d_kbps, avg_u_kbps, avg_lat_ms,
avg_lat_down_ms, avg_lat_up_ms, tests, devices (2025 Q4: 3,311,092 rows).
"""

from __future__ import annotations

import argparse
import re
import urllib.request
from datetime import date

import _common  # noqa: F401
from _common import RAW, SOURCES

BUCKET = "https://ookla-open-data.s3.amazonaws.com"
KEY = "parquet/performance/type=mobile/year={y}/quarter={q}/{y}-{m:02d}-01_performance_mobile_tiles.parquet"


def available_quarters() -> list[tuple[int, int]]:
    out = []
    for y in range(2019, date.today().year + 1):
        url = f"{BUCKET}/?list-type=2&prefix=parquet/performance/type=mobile/year={y}/"
        with urllib.request.urlopen(url, timeout=60) as r:
            xml = r.read().decode()
        out += [(int(a), int(b)) for a, b in re.findall(r"year=(\d{4})/quarter=(\d)/", xml)]
    return sorted(set(out))


def download(quarters: int, bbox) -> None:
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    w, s, e, n = bbox
    for y, q in available_quarters()[-quarters:]:
        dest = RAW / "ookla" / f"mobile_{y}Q{q}.parquet"
        if dest.exists():
            print(f"exists: {dest}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f"{BUCKET}/{KEY.format(y=y, q=q, m=3 * (q - 1) + 1)}"
        con.execute(f"""
            copy (select quadkey, tile_x, tile_y, avg_d_kbps, avg_u_kbps, avg_lat_ms, tests, devices,
                         '{y}Q{q}' as quarter
                  from read_parquet('{url}')
                  where tile_x between {w} and {e} and tile_y between {s} and {n})
            to '{dest}' (format parquet)""")
        print(f"wrote {dest}: {con.execute(f"select count(*) from '{dest}'").fetchone()[0]} tiles")


def build() -> None:
    import duckdb

    SOURCES.mkdir(parents=True, exist_ok=True)
    dest = SOURCES / "ookla_mobile.parquet"
    duckdb.connect().execute(f"""
        copy (select quadkey, quarter, avg_u_kbps::double as avg_u_kbps, avg_d_kbps::double as avg_d_kbps,
                     avg_lat_ms::double as avg_lat_ms, tests, devices
              from read_parquet('{RAW / "ookla"}/mobile_*.parquet'))
        to '{dest}' (format parquet)""")
    print(f"wrote {dest}")


def main() -> None:
    from pos_model.loaders import NIGERIA_BBOX

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download")
    d.add_argument("--quarters", type=int, default=4)
    d.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=NIGERIA_BBOX)
    sub.add_parser("build")
    sub.add_parser("list", help="print available quarters")
    a = ap.parse_args()
    if a.cmd == "download":
        download(a.quarters, a.bbox)
    elif a.cmd == "build":
        build()
    else:
        print(available_quarters())


if __name__ == "__main__":
    main()
