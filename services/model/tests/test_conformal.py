import math

import numpy as np

from pos_model.conformal import cross_fold_coverage, interval, quantile, scores


def test_quantile_index():
    s = np.arange(1, 10, dtype=float)  # n = 9, alpha 0.1 -> k = ceil(10 * 0.9) = 9
    assert quantile(s, 0.1) == 9.0
    s = np.arange(1, 20, dtype=float)  # n = 19 -> k = 18
    assert quantile(s, 0.1) == 18.0
    assert math.isinf(quantile(np.arange(1, 5, dtype=float), 0.1))  # too few points
    assert math.isinf(quantile([], 0.1))


def test_interval_clipped_and_symmetric():
    lo, hi = interval(np.array([0.5, 0.98]), 0.5)
    assert np.isclose(lo[0], 0.5 - 0.275) and np.isclose(hi[0], 0.5 + 0.275)  # half = q (sqrt(p(1-p)) + 0.05)
    lo, hi = interval(np.array([0.5, 0.98]), 2.0)
    assert lo[0] == 0.0 and hi[0] == 1.0 and hi[1] == 1.0 and 0 <= lo[1] < 0.98


def test_split_conformal_marginal_coverage(rng):
    # Exchangeable calibration and test points: coverage >= 1 - alpha on average
    # and <= 1 - alpha + 1/(n+1) (no ties).
    n, trials, hits = 200, 400, []
    for _ in range(trials):
        p = rng.uniform(0.05, 0.95, n + 1)
        r = np.clip(p + rng.normal(0, 0.15, n + 1), 0, 1)
        q = quantile(scores(r[:n], p[:n]), 0.1)
        lo, hi = interval(p[n:], q)
        hits.append(bool(lo[0] <= r[n] <= hi[0]))
    cov = np.mean(hits)
    se = math.sqrt(0.9 * 0.1 / trials)
    assert 0.9 - 3 * se <= cov <= 0.9 + 1 / (n + 1) + 3 * se


def test_cross_fold_coverage(rng):
    p = rng.uniform(0.1, 0.9, 2000)
    r = np.clip(p + rng.normal(0, 0.1, 2000), 0, 1)
    out = cross_fold_coverage(r, p, rng.integers(0, 5, 2000), 0.1)
    assert abs(out["coverage_cv"] - 0.9) < 0.03 and out["n_cal"] == 2000
