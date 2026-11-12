#!/usr/bin/env python3
"""Import an INEC or CredibleVoteNG polling-unit list (CSV) into public.polling_units.

Codes are normalised to the polling_units format SS-LL-WW-UUU, zero-padded:
"24/5/8/5", "24-05-08-005" or separate state/LGA/ward/unit code columns all
become "24-05-08-005". Coordinates outside Nigeria's bounding box (including
0,0 placeholders) are dropped. A unit's point is only set when it has none,
has a crowd point, or has a CredibleVoteNG point and the new source is INEC.

Sources: INEC polling unit locator (https://inecelectionresults.ng / INEC PU
data), CredibleVoteNG PU geolocations. Both are public lists; keep their
attribution in anything republished. Download them by hand into data/raw/pus/
(neither has a stable bulk API).

    DATABASE_URL=... services/model/.venv/bin/python data/import_pus.py data/raw/pus/inec.csv --source inec
    services/model/.venv/bin/python data/import_pus.py data/raw/pus/cv.csv --source crediblevote --dry-run
"""

from __future__ import annotations

import argparse

import _common  # noqa: F401
from _common import connect


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--source", choices=["inec", "crediblevote"], required=True)
    ap.add_argument("--dry-run", action="store_true", help="parse and print a summary, write nothing")
    a = ap.parse_args()
    from pos_model.loaders import read_pu_list, upsert_pus

    df = read_pu_list(a.csv, a.source)
    print(f"{len(df)} units, {df['lat'].notna().sum()} with a point; states: "
          f"{sorted(df['pu_code'].str[:2].unique().tolist())}")
    print(df.head().to_string())
    if not a.dry_run:
        print(f"upserted {upsert_pus(connect(), df)} units")


if __name__ == "__main__":
    main()
