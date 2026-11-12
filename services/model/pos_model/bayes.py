"""Beta-Binomial update of the model prior with a unit's real tests.

Prior Beta(k p, k (1 - p)) is worth k = 4 pseudo-tests at the model's p.
Each accepted evening test adds its trust weight w to alpha (success) or to
beta (failure). The posterior mean is the published p; the 5th and 95th
percentiles are the published interval.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import beta as beta_dist

from .config import P_CLIP, POSTERIOR_HI_Q, POSTERIOR_LO_Q, PRIOR_PSEUDO_TESTS


def posterior(p_model, w_success, w_failure, k: float = PRIOR_PSEUDO_TESTS,
              lo_q: float = POSTERIOR_LO_Q, hi_q: float = POSTERIOR_HI_Q):
    """Returns (mean, lo, hi, alpha, beta), vectorised."""
    p = np.clip(np.asarray(p_model, dtype=float), *P_CLIP)
    a = k * p + np.asarray(w_success, dtype=float)
    b = k * (1 - p) + np.asarray(w_failure, dtype=float)
    mean = a / (a + b)
    lo = beta_dist.ppf(lo_q, a, b)
    hi = beta_dist.ppf(hi_q, a, b)
    # For very skewed posteriors the mean can sit outside [q05, q95]; the
    # predictions table requires p_lo <= p <= p_hi.
    lo = np.minimum(lo, mean)
    hi = np.maximum(hi, mean)
    return mean, lo, hi, a, b
