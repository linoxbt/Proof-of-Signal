import numpy as np
from scipy.stats import beta as beta_dist

from pos_model.bayes import posterior


def _numeric_quantile(a, b, q, n=400_001):
    # Independent check of the Beta quantile by integrating the density.
    x = np.linspace(0, 1, n)[1:-1]
    pdf = np.exp((a - 1) * np.log(x) + (b - 1) * np.log1p(-x))
    cdf = np.cumsum(pdf)
    cdf /= cdf[-1]
    return x[np.searchsorted(cdf, q)]


def test_prior_only_is_beta_k_p():
    mean, lo, hi, a, b = posterior(0.5, 0.0, 0.0)
    assert a == 2.0 and b == 2.0 and mean == 0.5
    assert abs(lo - _numeric_quantile(2, 2, 0.05)) < 1e-4
    assert abs(hi - _numeric_quantile(2, 2, 0.95)) < 1e-4


def test_trust_weighted_update():
    # Prior worth 4 tests at p = 0.8: Beta(3.2, 0.8). Three tests: success w=0.9,
    # success w=0.5, failure w=0.7 -> Beta(4.6, 1.5).
    mean, lo, hi, a, b = posterior(0.8, 0.9 + 0.5, 0.7)
    assert np.isclose(a, 4.6) and np.isclose(b, 1.5)
    assert np.isclose(mean, 4.6 / 6.1)
    assert np.isclose(lo, beta_dist.ppf(0.05, 4.6, 1.5)) and np.isclose(hi, beta_dist.ppf(0.95, 4.6, 1.5))
    assert abs(lo - _numeric_quantile(4.6, 1.5, 0.05)) < 1e-3


def test_low_trust_failure_moves_less():
    m_low, *_ = posterior(0.9, 0.0, 0.2 * 1.0)
    m_full, *_ = posterior(0.9, 0.0, 1.0)
    assert m_full < m_low < 0.9


def test_more_tests_narrow_interval_and_order_holds():
    _, lo1, hi1, _, _ = posterior(0.6, 1.5, 1.0)
    _, lo2, hi2, _, _ = posterior(0.6, 15.0, 10.0)
    assert hi2 - lo2 < hi1 - lo1
    p = np.array([0.005, 0.01, 0.5, 0.995])
    mean, lo, hi, _, _ = posterior(p, np.zeros(4), np.array([5.0, 0.0, 0.0, 0.0]))
    assert np.all(lo <= mean) and np.all(mean <= hi) and np.all((0 <= lo) & (hi <= 1))
