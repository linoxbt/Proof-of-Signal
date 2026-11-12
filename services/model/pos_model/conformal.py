"""Split-conformal intervals for a unit's success probability.

Calibration points are unit-carriers with at least CONFORMAL_MIN_TESTS evening
tests, scored with out-of-fold (spatial CV) predictions, so the model that
scored a point never saw that unit's block. The nonconformity score is
normalised so intervals are narrower near 0 and 1:

    s = |r - p| / (sqrt(p (1 - p)) + floor)

with r the unit's trust-weighted observed success rate and p the calibrated
prediction. q is the ceil((n + 1)(1 - alpha))-th smallest score, and the
interval is p -/+ q (sqrt(p (1 - p)) + floor), clipped to [0, 1].

r is itself a noisy estimate from a few tests, so the interval covers the
*observed* rate of a newly measured unit; it is conservative as an interval
for the unit's true rate.
"""

from __future__ import annotations

import math

import numpy as np

from .config import CONFORMAL_ALPHA, CONFORMAL_SCALE_FLOOR


def scale(p, floor: float = CONFORMAL_SCALE_FLOOR):
    p = np.asarray(p, dtype=float)
    return np.sqrt(np.clip(p * (1 - p), 0, None)) + floor


def scores(r, p, floor: float = CONFORMAL_SCALE_FLOOR) -> np.ndarray:
    return np.abs(np.asarray(r, dtype=float) - np.asarray(p, dtype=float)) / scale(p, floor)


def quantile(s, alpha: float = CONFORMAL_ALPHA) -> float:
    """Finite-sample split-conformal quantile. inf when n is too small."""
    s = np.sort(np.asarray(s, dtype=float))
    n = len(s)
    k = math.ceil((n + 1) * (1 - alpha))
    if n == 0 or k > n:
        return float("inf")
    return float(s[k - 1])


def interval(p, q: float, floor: float = CONFORMAL_SCALE_FLOOR):
    p = np.asarray(p, dtype=float)
    half = q * scale(p, floor)
    return np.clip(p - half, 0, 1), np.clip(p + half, 0, 1)


def cross_fold_coverage(r, p, folds, alpha: float = CONFORMAL_ALPHA,
                        floor: float = CONFORMAL_SCALE_FLOOR) -> dict:
    """Honest coverage estimate: for each fold, q from the other folds' scores,
    coverage measured on this fold."""
    r = np.asarray(r, dtype=float)
    p = np.asarray(p, dtype=float)
    folds = np.asarray(folds)
    s = scores(r, p, floor)
    covered = np.zeros(len(r), dtype=bool)
    width = np.zeros(len(r))
    for f in np.unique(folds):
        m = folds == f
        q = quantile(s[~m], alpha)
        lo, hi = interval(p[m], q, floor)
        covered[m] = (r[m] >= lo - 1e-12) & (r[m] <= hi + 1e-12)
        width[m] = hi - lo
    return {
        "n_cal": int(len(r)),
        "coverage_cv": float(covered.mean()) if len(r) else None,
        "mean_width_cv": float(width.mean()) if len(r) else None,
    }
