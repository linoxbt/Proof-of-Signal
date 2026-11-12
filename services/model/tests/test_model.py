import numpy as np
import pytest

from pos_model import config as C
from pos_model.features import MONOTONE_DECREASING
from pos_model.metrics import ece
from pos_model.model import Calibrator, load_artefact, predict, save_artefact, unit_evidence


def test_model_beats_both_baselines(trained):
    m = trained.metrics
    b = m["baselines"]
    for name in ("tower_distance_logistic", "ookla_tile_logistic"):
        assert m["model"]["auc"] > b[name]["auc"] + 0.02, (name, m["model"], b[name])
        assert m["model"]["brier"] < b[name]["brier"], (name, m["model"], b[name])
        assert m["model"]["log_loss"] < b[name]["log_loss"]


def test_calibrated_ece_meets_target(trained):
    m = trained.metrics
    assert m["model"]["ece"] <= C.ECE_TARGET and m["ece_ok"]
    # The reported number is the ECE of the stored out-of-fold calibrated predictions.
    assert np.isclose(m["model"]["ece"], ece(trained.oof["y"], trained.oof["cal"]))


def test_calibrator_is_monotone_and_bounded(trained):
    x = np.linspace(-0.5, 1.5, 500)
    y = trained.calibrator(x)
    assert np.all(np.diff(y) >= -1e-12) and y.min() >= 0 and y.max() <= 1


def test_calibrator_fixes_a_miscalibrated_score(rng):
    p_true = rng.uniform(0, 1, 20000)
    y = rng.random(20000) < p_true
    raw = p_true**3  # badly calibrated but monotone
    cal = Calibrator.fit(raw[:10000], y[:10000])(raw[10000:])
    assert ece(y[10000:], raw[10000:]) > 0.15 and ece(y[10000:], cal) < 0.03


@pytest.mark.parametrize("col", MONOTONE_DECREASING)
def test_monotone_constraints_hold(trained, feats, col):
    rows = feats.sample(150, random_state=1).reset_index(drop=True)
    lo, hi = np.nanpercentile(feats[col], [0, 100])
    grid = np.linspace(lo, hi * 1.2 + 1, 25)
    X = rows.loc[rows.index.repeat(len(grid))].reset_index(drop=True)
    X[col] = np.tile(grid, len(rows))
    raw = trained.booster.predict(X[trained.columns]).reshape(len(rows), len(grid))
    cal = trained.calibrator(raw)
    assert np.all(np.diff(raw, axis=1) <= 1e-12), f"raw score rises with {col}"
    assert np.all(np.diff(cal, axis=1) <= 1e-12), f"calibrated p rises with {col}"


def test_conformal_coverage_close_to_nominal(trained):
    iv = trained.metrics["interval"]
    assert iv["n_cal"] >= 100 and np.isfinite(trained.q)
    assert 0.84 <= iv["coverage_cv"] <= 0.96, iv


def test_artefact_roundtrip_and_predict(tmp_path, trained, feats, world):
    uri, sha = save_artefact(trained, tmp_path / "v1")
    art = load_artefact(tmp_path / "v1")
    assert art.sha256 == sha and uri.startswith("file://")
    np.testing.assert_allclose(art.p_model(feats.head(50)),
                               np.clip(trained.calibrator(trained.booster.predict(feats.head(50)[trained.columns])), *C.P_CLIP))
    ev = unit_evidence(world.labels())
    out = predict(art, feats, ev)
    assert len(out) == len(feats.drop_duplicates(["pu_code", "mnc"]))
    assert ((0 <= out["p_lo"]) & (out["p_lo"] <= out["p"]) & (out["p"] <= out["p_hi"]) & (out["p_hi"] <= 1)).all()
    none = out[out["n_tests"] == 0]
    assert (none["p"] == none["p_model"]).all() and not none["measured"].any()
    tested = out[out["n_tests"] > 0].merge(ev, on=["pu_code", "mnc"], suffixes=("", "_ev"))
    # Posterior mean (k = 4 pseudo-tests at p_model plus trust-weighted tests).
    exp = (4 * tested["p_model"] + tested["w_success_ev"]) / (4 + tested["w_success_ev"] + tested["w_failure_ev"])
    assert np.allclose(tested["p"], exp, atol=2e-4)
    assert (tested["measured"] == tested["measured_ev"]).all()
    # Trained units use their out-of-fold prior, not the in-sample prediction.
    k = trained.oof_unit.iloc[0]
    row = out[(out["pu_code"] == k["pu_code"]) & (out["mnc"] == k["mnc"])].iloc[0]
    assert abs(row["p_model"] - k["p_oof"]) < 1e-4


def test_predictions_track_ground_truth(trained, feats, world):
    p = np.clip(trained.calibrator(trained.booster.predict(feats[trained.columns])), *C.P_CLIP)
    t = feats[["pu_code", "mnc"]].assign(p=p).merge(world.truth, on=["pu_code", "mnc"])
    assert np.corrcoef(t["p"], t["p_true"])[0, 1] > 0.6
