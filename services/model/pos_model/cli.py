"""pos-model command line.

    pos-model features [--sources DIR] [--feature-version fv1]
    pos-model reweight
    pos-model train    [--feature-version fv1] [--artefacts DIR] [--no-reweight]
    pos-model predict  [--model-version ID] [--artefacts DIR] [--no-current]
    pos-model freeze   --election ID [--model-version ID]
    pos-model demo     [--seed 7] [--n-pus 1000] [--sources DIR] [--freeze ELECTION]

Every command reads DATABASE_URL (or --database-url) and prints a JSON summary.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from . import config as C


def _print(obj) -> None:
    json.dump(obj, sys.stdout, indent=2, sort_keys=True, default=str)
    sys.stdout.write("\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pos-model", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", help="defaults to $DATABASE_URL")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("features", help="build features for every unit and carrier")
    p.add_argument("--sources", type=Path, help=f"processed sources (default {C.sources_dir()})")
    p.add_argument("--feature-version", default=C.FEATURE_VERSION)

    sub.add_parser("reweight", help="apply the outlier trust factor to accepted tests (idempotent)")

    p = sub.add_parser("train", help="spatial CV, calibration, conformal; registers a model version")
    p.add_argument("--feature-version", default=C.FEATURE_VERSION)
    p.add_argument("--artefacts", type=Path, help=f"artefact root (default {C.artefact_dir()})")
    p.add_argument("--no-reweight", action="store_true", help="skip the outlier re-weighting step")

    p = sub.add_parser("predict", help="write predictions for a model version and make it current")
    p.add_argument("--model-version", help="default: the most recently trained")
    p.add_argument("--artefacts", type=Path)
    p.add_argument("--no-current", action="store_true", help="write predictions without setting is_current")

    p = sub.add_parser("freeze", help="freeze_snapshot(election, model_version)")
    p.add_argument("--election", required=True)
    p.add_argument("--model-version", help="default: the current model version")

    p = sub.add_parser("demo", help="fill a DEV database with the synthetic world and run the whole pipeline")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--n-pus", type=int, default=1000)
    p.add_argument("--sources", type=Path, help="where to write synthetic sources (default data/cache/sources-synthetic)")
    p.add_argument("--artefacts", type=Path)
    p.add_argument("--freeze", metavar="ELECTION", help="also freeze a snapshot for this election")

    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from . import pipeline

    conn = pipeline.connect(a.database_url)
    try:
        if a.cmd == "features":
            f = pipeline.build_features(conn, a.sources, a.feature_version)
            _print({"feature_version": a.feature_version, "rows": len(f), "units": int(f["pu_code"].nunique())})
        elif a.cmd == "reweight":
            _print(pipeline.reweight_outliers(conn))
        elif a.cmd == "train":
            out = {}
            if not a.no_reweight:
                out["outliers"] = pipeline.reweight_outliers(conn)
            version, metrics = pipeline.train_and_register(conn, a.feature_version, a.artefacts)
            out.update({"model_version": version,
                        "metrics": {k: metrics[k] for k in ("model", "baselines", "interval", "ece_ok")}})
            _print(out)
        elif a.cmd == "predict":
            _print(pipeline.predict_and_publish(conn, a.model_version, a.artefacts, make_current=not a.no_current))
        elif a.cmd == "freeze":
            _print(pipeline.freeze(conn, a.election, a.model_version))
        elif a.cmd == "demo":
            from .demo import run_demo

            _print(run_demo(conn, a.seed, a.n_pus, a.sources, a.artefacts, a.freeze))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
