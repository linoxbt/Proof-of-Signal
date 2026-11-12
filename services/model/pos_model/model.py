"""Training, calibration, baselines, conformal intervals and prediction.

Everything here works on pandas frames; pipeline.py moves them to and from
Postgres. The trained artefact is a LightGBM text model plus a JSON file (no
pickles), so it can be published and hashed.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

from . import config as C
from .bayes import posterior
from .conformal import cross_fold_coverage, interval, quantile, scores
from .cv import unit_folds
from .features import CONTEXT_COLS, MONOTONE_DECREASING, spatial_context
from .metrics import score

log = logging.getLogger(__name__)

LGB_PARAMS = {
    "objective": "binary",
    "learning_rate": 0.03,
    "num_leaves": 15,
    "min_data_in_leaf": 20,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "monotone_constraints_method": "intermediate",
    "verbose": -1,
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": 4,
}
NUM_ROUNDS = 300


# --- evidence ------------------------------------------------------------------

def unit_evidence(labels: pd.DataFrame) -> pd.DataFrame:
    """Per (unit, carrier) counts and trust-weighted successes, mirroring the
    pu_carrier_evidence view. labels: test_id, pu_code, mnc, success, trust,
    device_id, local_date."""
    g = labels.assign(ws=labels["trust"] * labels["success"], wf=labels["trust"] * (~labels["success"].astype(bool)))
    ev = g.groupby(["pu_code", "mnc"]).agg(
        n_tests=("test_id", "size"), n_devices=("device_id", "nunique"), n_evenings=("local_date", "nunique"),
        w_success=("ws", "sum"), w_failure=("wf", "sum"),
    ).reset_index()
    ev["measured"] = (ev["n_tests"] >= C.MEASURED_MIN_TESTS) & (ev["n_devices"] >= C.MEASURED_MIN_DEVICES) & (
        ev["n_evenings"] >= C.MEASURED_MIN_EVENINGS)
    tot = ev["w_success"] + ev["w_failure"]
    ev["rate"] = np.where(tot > 0, ev["w_success"] / tot.where(tot > 0, 1), np.nan)
    return ev


def context_pool(ev: pd.DataFrame, units: pd.DataFrame) -> pd.DataFrame:
    m = ev[ev["measured"] & ev["rate"].notna()][["pu_code", "mnc", "rate"]]
    return m.merge(units[["pu_code", "lat", "lng"]].drop_duplicates("pu_code"), on="pu_code", how="inner")


# --- model pieces --------------------------------------------------------------

def monotone_vector(columns: list[str]) -> list[int]:
    return [-1 if c in MONOTONE_DECREASING else 0 for c in columns]


def fit_lgbm(X: pd.DataFrame, y, w, columns: list[str], seed: int = C.RANDOM_SEED) -> lgb.Booster:
    params = dict(LGB_PARAMS, seed=seed, monotone_constraints=monotone_vector(columns))
    ds = lgb.Dataset(X[columns], label=np.asarray(y, dtype=float), weight=np.asarray(w, dtype=float),
                     categorical_feature=["mnc"], free_raw_data=False)
    return lgb.train(params, ds, num_boost_round=NUM_ROUNDS)


def _distance_x(frame: pd.DataFrame) -> np.ndarray:
    d = frame["d1_m"].fillna(50_000).clip(lower=10, upper=50_000)
    return np.log(d.to_numpy(dtype=float)).reshape(-1, 1)


def _ookla_x(frame: pd.DataFrame, fill: float) -> np.ndarray:
    u = frame["ookla_u_kbps"]
    miss = u.isna().to_numpy(dtype=float)
    v = np.log1p(u.fillna(fill).clip(lower=0).to_numpy(dtype=float))
    return np.column_stack([v, miss])


def fit_baselines(train: pd.DataFrame, y, w):
    if np.unique(y).size < 2:
        raise ValueError("training fold has a single class")
    dist = LogisticRegression(C=1.0, max_iter=1000).fit(_distance_x(train), y, sample_weight=w)
    fill = float(train["ookla_u_kbps"].median()) if train["ookla_u_kbps"].notna().any() else 0.0
    xo = _ookla_x(train, fill)
    ook = LogisticRegression(C=1.0, max_iter=1000).fit(xo, y, sample_weight=w)
    return dist, ook, fill


def oof_context(pairs: pd.DataFrame, pool: pd.DataFrame, fold: int, return_neighbours: bool = False) -> pd.DataFrame:
    """Spatial context for CV fold `fold`: the neighbour pool excludes every
    unit in that fold, so validation rows never see their fold's labels."""
    return spatial_context(pairs, pool[pool["fold"] != fold], return_neighbours=return_neighbours)


@dataclass
class Calibrator:
    x: np.ndarray
    y: np.ndarray

    @classmethod
    def fit(cls, raw, y, w=None) -> "Calibrator":
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip", increasing=True)
        iso.fit(np.asarray(raw, dtype=float), np.asarray(y, dtype=float), sample_weight=w)
        return cls(np.asarray(iso.X_thresholds_, dtype=float), np.asarray(iso.y_thresholds_, dtype=float))

    def __call__(self, raw):
        return np.interp(np.asarray(raw, dtype=float), self.x, self.y)


# --- training ------------------------------------------------------------------

@dataclass
class TrainResult:
    booster: lgb.Booster
    calibrator: Calibrator
    columns: list[str]
    q: float
    metrics: dict
    oof: pd.DataFrame  # row-level: pu_code, mnc, fold, y, w, raw, cal, base_dist, base_ookla
    oof_unit: pd.DataFrame  # pu_code, mnc, p_oof
    folds: pd.DataFrame
    feature_version: str = C.FEATURE_VERSION
    extra: dict = field(default_factory=dict)


def train(features: pd.DataFrame, labels: pd.DataFrame, columns: list[str],
          n_folds: int = C.CV_FOLDS, seed: int = C.RANDOM_SEED, h3_res: int = C.H3_RES) -> TrainResult:
    """features: one row per (pu_code, mnc) with lat, lng, state_code and the
    feature columns (ctx_* as built for deployment). labels: evening accepted
    (test, SIM) rows."""
    labels = labels[labels["trust"] > 0].copy()
    labels["success"] = labels["success"].astype(bool)
    feats = features.drop_duplicates(["pu_code", "mnc"])
    rows = labels.merge(feats, on=["pu_code", "mnc"], how="inner").reset_index(drop=True)
    if rows.empty:
        raise ValueError("no labelled rows with features")
    if rows["success"].nunique() < 2:
        raise ValueError("labels have a single class; cannot train")
    dropped = len(labels) - len(rows)
    if dropped:
        log.warning("%d labelled rows have no features (unit without a point?) and are skipped", dropped)

    units = feats[["pu_code", "lat", "lng"]].drop_duplicates("pu_code")
    folds = unit_folds(rows[["pu_code", "lat", "lng"]], rows.groupby("pu_code").size(), n_folds, seed, h3_res)
    rows = rows.merge(folds[["pu_code", "fold"]], on="pu_code", how="left")
    ev = unit_evidence(labels)
    pool = context_pool(ev, units)
    pool = pool.merge(folds[["pu_code", "fold"]], on="pu_code", how="left")

    y = rows["success"].to_numpy(dtype=float)
    w = rows["trust"].to_numpy(dtype=float)
    raw = np.full(len(rows), np.nan)
    b_dist = np.full(len(rows), np.nan)
    b_ook = np.full(len(rows), np.nan)
    pairs = rows[["pu_code", "mnc", "lat", "lng"]].drop_duplicates(["pu_code", "mnc"])

    for f in range(n_folds):
        val = (rows["fold"] == f).to_numpy()
        if not val.any():
            continue
        # Out-of-fold spatial context: neighbours' labels come only from
        # units outside fold f, for training and validation rows alike.
        ctx = oof_context(pairs.reset_index(drop=True), pool, f)
        ctx = pd.concat([pairs.reset_index(drop=True)[["pu_code", "mnc"]], ctx], axis=1)
        X = rows.drop(columns=CONTEXT_COLS).merge(ctx, on=["pu_code", "mnc"], how="left")
        tr = ~val
        bst = fit_lgbm(X[tr], y[tr], w[tr], columns, seed)
        raw[val] = bst.predict(X.loc[val, columns])
        dist, ook, fill = fit_baselines(X[tr], y[tr], w[tr])
        b_dist[val] = dist.predict_proba(_distance_x(X[val]))[:, 1]
        b_ook[val] = ook.predict_proba(_ookla_x(X[val], fill))[:, 1]

    # Cross-fitted calibration for honest metrics: fold f is calibrated by an
    # isotonic map fitted on the other folds' out-of-fold scores.
    cal = np.full(len(rows), np.nan)
    fold_arr = rows["fold"].to_numpy()
    for f in np.unique(fold_arr):
        m = fold_arr == f
        cal[m] = Calibrator.fit(raw[~m], y[~m], w[~m])(raw[m])
    cal = np.clip(cal, *C.P_CLIP)
    calibrator = Calibrator.fit(raw, y, w)

    oof = pd.DataFrame({
        "pu_code": rows["pu_code"], "mnc": rows["mnc"], "state_code": rows["state_code"], "fold": fold_arr,
        "y": y, "w": w, "raw": raw, "cal": cal, "base_dist": b_dist, "base_ookla": b_ook,
    })

    # Conformal calibration on unit-carriers with enough tests.
    unit_oof = oof.groupby(["pu_code", "mnc"]).agg(p_oof=("cal", "mean"), fold=("fold", "first")).reset_index()
    cal_pts = unit_oof.merge(ev, on=["pu_code", "mnc"])
    cal_pts = cal_pts[(cal_pts["n_tests"] >= C.CONFORMAL_MIN_TESTS) & cal_pts["rate"].notna()]
    q = quantile(scores(cal_pts["rate"], cal_pts["p_oof"]), C.CONFORMAL_ALPHA)
    cover = cross_fold_coverage(cal_pts["rate"], cal_pts["p_oof"], cal_pts["fold"], C.CONFORMAL_ALPHA)

    # Final model on all rows with deployment context features.
    booster = fit_lgbm(rows, y, w, columns, seed)

    metrics = {
        "n_rows": int(len(rows)), "n_units": int(rows["pu_code"].nunique()),
        "n_unit_carriers": int(len(unit_oof)), "n_blocks": int(folds["block"].nunique()),
        "cv": {"folds": n_folds, "h3_res": h3_res, "scheme": "spatial block (H3)"},
        "model": score(y, cal), "model_uncalibrated": score(y, raw),
        "baselines": {"tower_distance_logistic": score(y, b_dist), "ookla_tile_logistic": score(y, b_ook)},
        "interval": {"method": "split-conformal on spatial out-of-fold predictions, normalised score",
                     "alpha": C.CONFORMAL_ALPHA, "q": q if np.isfinite(q) else None, **cover},
        "ece_target": C.ECE_TARGET,
        "by_state": _grouped(oof, "state_code"), "by_carrier": _grouped(oof, "mnc"),
        "feature_importance_gain": dict(zip(columns, map(float, booster.feature_importance("gain")))),
        "monotone_decreasing": [c for c in columns if c in MONOTONE_DECREASING],
        "beta_binomial": {"prior_pseudo_tests": C.PRIOR_PSEUDO_TESTS, "quantiles": [C.POSTERIOR_LO_Q, C.POSTERIOR_HI_Q]},
    }
    metrics["ece_ok"] = metrics["model"]["ece"] <= C.ECE_TARGET
    return TrainResult(booster, calibrator, columns, q, metrics, oof, unit_oof[["pu_code", "mnc", "p_oof"]], folds)


def _grouped(oof: pd.DataFrame, key: str) -> dict:
    out = {}
    for k, g in oof.groupby(key):
        out[str(int(k))] = {
            "model": score(g["y"], g["cal"]),
            "tower_distance_logistic": score(g["y"], g["base_dist"]),
            "ookla_tile_logistic": score(g["y"], g["base_ookla"]),
        }
    return out


# --- artefact --------------------------------------------------------------------

@dataclass
class Artefact:
    booster: lgb.Booster
    calibrator: Calibrator
    columns: list[str]
    q: float
    feature_version: str
    oof_prior: dict  # (pu_code, mnc) -> calibrated out-of-fold p
    uri: str = ""
    sha256: str = ""

    def p_model(self, frame: pd.DataFrame) -> np.ndarray:
        X = frame.copy()
        for c in self.columns:
            if c not in X:
                X[c] = 0.0 if c.startswith("is_state_") else np.nan
        return np.clip(self.calibrator(self.booster.predict(X[self.columns])), *C.P_CLIP)


def save_artefact(res: TrainResult, directory: Path) -> tuple[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    model_path = directory / "model.txt"
    res.booster.save_model(str(model_path))
    meta = {
        "feature_version": res.feature_version, "columns": res.columns,
        "monotone": monotone_vector(res.columns), "categorical": ["mnc"],
        "isotonic": {"x": res.calibrator.x.tolist(), "y": res.calibrator.y.tolist()},
        "conformal": {"q": res.q if np.isfinite(res.q) else None, "alpha": C.CONFORMAL_ALPHA,
                      "floor": C.CONFORMAL_SCALE_FLOOR},
        "p_clip": list(C.P_CLIP),
        "oof_prior": [[r.pu_code, int(r.mnc), float(r.p_oof)] for r in res.oof_unit.itertuples()],
        "metrics": res.metrics,
    }
    (directory / "artefact.json").write_text(json.dumps(meta, sort_keys=True, default=_json_default))
    return directory.resolve().as_uri(), artefact_sha256(directory)


def artefact_sha256(directory: Path) -> str:
    """sha256 over model.txt then artefact.json (recorded in model_versions.artefact_sha256)."""
    h = hashlib.sha256()
    for name in ("model.txt", "artefact.json"):
        h.update((directory / name).read_bytes())
    return h.hexdigest()


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(type(o))


def load_artefact(directory: Path) -> Artefact:
    meta = json.loads((directory / "artefact.json").read_text())
    booster = lgb.Booster(model_file=str(directory / "model.txt"))
    q = meta["conformal"]["q"]
    return Artefact(
        booster=booster,
        calibrator=Calibrator(np.array(meta["isotonic"]["x"]), np.array(meta["isotonic"]["y"])),
        columns=meta["columns"], q=float("inf") if q is None else float(q),
        feature_version=meta["feature_version"],
        oof_prior={(a, int(b)): float(c) for a, b, c in meta["oof_prior"]},
        uri=directory.resolve().as_uri(), sha256=artefact_sha256(directory),
    )


# --- prediction -------------------------------------------------------------------

def predict(art: Artefact, features: pd.DataFrame, evidence: pd.DataFrame) -> pd.DataFrame:
    """features: (pu_code, mnc, ...). evidence: pu_carrier_evidence rows
    (pu_code, mnc, n_tests, n_devices, n_evenings, w_success, w_failure, measured).

    p_model: calibrated model prediction; for units that were in training it
    is their out-of-fold prediction, so their own tests are not counted twice
    in the Beta-Binomial update.
    Units with accepted evening tests: Beta-Binomial posterior (mean, q05, q95).
    Units without: p = p_model, conformal interval."""
    f = features.drop_duplicates(["pu_code", "mnc"]).reset_index(drop=True)
    p_model = art.p_model(f)
    keys = list(zip(f["pu_code"], f["mnc"].astype(int)))
    prior = np.array([art.oof_prior.get(k, np.nan) for k in keys])
    p_model = np.where(np.isfinite(prior), prior, p_model)
    out = pd.DataFrame({"pu_code": f["pu_code"], "mnc": f["mnc"].astype(int), "p_model": p_model})
    ev = evidence[["pu_code", "mnc", "n_tests", "n_devices", "n_evenings", "w_success", "w_failure", "measured"]]
    out = out.merge(ev, on=["pu_code", "mnc"], how="left")
    for c in ("n_tests", "n_devices", "n_evenings"):
        out[c] = out[c].fillna(0).astype(int)
    for c in ("w_success", "w_failure"):
        out[c] = out[c].fillna(0.0).astype(float)
    out["measured"] = out["measured"].fillna(False).astype(bool)

    lo, hi = interval(out["p_model"].to_numpy(), art.q)
    out["p"], out["p_lo"], out["p_hi"] = out["p_model"], lo, hi
    has = out["n_tests"].to_numpy() > 0
    if has.any():
        mean, plo, phi, _, _ = posterior(out.loc[has, "p_model"], out.loc[has, "w_success"], out.loc[has, "w_failure"])
        out.loc[has, "p"], out.loc[has, "p_lo"], out.loc[has, "p_hi"] = mean, plo, phi
    # numeric(5,4) and 0 <= p_lo <= p <= p_hi <= 1 after rounding.
    for c in ("p_model", "p", "p_lo", "p_hi"):
        out[c] = out[c].astype(float).clip(0, 1).round(4)
    out["p_lo"] = np.minimum(out["p_lo"], out["p"])
    out["p_hi"] = np.maximum(out["p_hi"], out["p"])
    return out
