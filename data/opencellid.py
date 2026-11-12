#!/usr/bin/env python3
"""OpenCellID towers for Nigeria (MCC 621) -> public.cells.

Licence: OpenCellID data is CC BY-SA 4.0 (https://opencellid.org). Attribute
"OpenCellID (opencellid.org), CC BY-SA 4.0"; anything derived from the tower
table (including the published coverage map) must carry the same licence terms.

Needs an API key in OPENCELLID_TOKEN (free account). Two ways in:

  download mcc   Per-country file https://opencellid.org/ocid/downloads?token=...&type=mcc&file=621.csv.gz
                 (one daily download quota; the full dump cell_towers.csv.gz also works with `load`).
  download area  Area API cell/getInArea for a bbox, tiled into small squares (rate limited; for a few LGAs).
  load FILE      Parse (header or headerless, .gz or plain) and upsert into public.cells.

    services/model/.venv/bin/python data/opencellid.py download mcc
    DATABASE_URL=... services/model/.venv/bin/python data/opencellid.py load data/raw/opencellid/621.csv.gz --verify-carriers

Checked 2026-11-12: getInArea without a valid key answers HTTP 401 with CSV body
"info,code / API Key not known,2", so the endpoint and CSV shape are as expected.
"""

from __future__ import annotations

import argparse
import os
import time
import urllib.request

import _common  # noqa: F401  (sets sys.path)
from _common import RAW, connect, download

import pandas as pd

DOWNLOAD_URL = "https://opencellid.org/ocid/downloads?token={token}&type=mcc&file=621.csv.gz"
AREA_URL = "https://opencellid.org/cell/getInArea?key={token}&BBOX={s},{w},{n},{e}&mcc=621&format=csv&limit=50&offset={offset}"


def _token() -> str:
    t = os.environ.get("OPENCELLID_TOKEN")
    if not t:
        raise SystemExit("set OPENCELLID_TOKEN (never commit it)")
    return t


def download_mcc() -> None:
    download(DOWNLOAD_URL.format(token=_token()), RAW / "opencellid" / "621.csv.gz")


def download_area(bbox, step: float = 0.015, pause: float = 1.0) -> None:
    """getInArea is limited to small boxes and 50 rows per call; walk the bbox."""
    from pos_model.loaders import read_opencellid

    token = _token()
    w, s, e, n = bbox
    frames = []
    lat = s
    while lat < n:
        lng = w
        while lng < e:
            offset = 0
            while True:
                url = AREA_URL.format(token=token, s=lat, w=lng, n=min(lat + step, n), e=min(lng + step, e), offset=offset)
                with urllib.request.urlopen(url, timeout=60) as r:
                    text = r.read().decode()
                if text.startswith("info,code") or not text.strip():
                    break
                df = read_opencellid(text)
                frames.append(df)
                if len(df) < 50:
                    break
                offset += 50
                time.sleep(pause)
            lng += step
            time.sleep(pause)
        lat += step
    out = pd.concat(frames, ignore_index=True).drop_duplicates(["radio", "mcc", "mnc", "area", "cid"]) if frames else None
    dest = RAW / "opencellid" / f"area_{w}_{s}_{e}_{n}.csv"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if out is None:
        print("no cells returned")
        return
    out.rename(columns={"mnc": "net", "cid": "cell", "lng": "lon", "range_m": "range", "ocid_samples": "samples"}) \
       .to_csv(dest, index=False)
    print(f"wrote {len(out)} cells to {dest}")


def load(path: str, verify_carriers: bool) -> None:
    from pos_model.loaders import read_opencellid, upsert_cells

    cells = read_opencellid(path)
    print(cells.groupby(["mnc", "radio"]).size().rename("cells").to_string())
    conn = connect()
    n = upsert_cells(conn, cells)
    print(f"upserted {n} cells")
    if verify_carriers:
        # carriers.verified: MNCs were typed from memory; mark those that the
        # OpenCellID rows actually contain (>= 100 cells) as verified.
        counts = cells["mnc"].value_counts()
        ok = [int(m) for m, c in counts.items() if c >= 100]
        conn.execute("update public.carriers set verified = true where mcc = 621 and mnc = any(%s)", (ok,))
        unknown = sorted(set(counts.index) - set(r[0] for r in conn.execute(
            "select mnc from public.carriers where mcc = 621").fetchall()))
        print(f"verified MNCs: {ok}; MNCs in data but not in carriers: {unknown}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download")
    d.add_argument("mode", choices=["mcc", "area"])
    d.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=(4.35, 8.25, 4.95, 8.85))
    l = sub.add_parser("load")
    l.add_argument("file")
    l.add_argument("--verify-carriers", action="store_true")
    a = ap.parse_args()
    if a.cmd == "download":
        download_mcc() if a.mode == "mcc" else download_area(tuple(a.bbox))
    else:
        load(a.file, a.verify_carriers)


if __name__ == "__main__":
    main()
