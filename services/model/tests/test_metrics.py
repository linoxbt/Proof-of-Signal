import numpy as np

from pos_model.metrics import auc, brier, ece


def test_ece_hand_computed():
    # bin 0.1-0.2: p = 0.1, 0.1; y = 0, 1 -> |0.5 - 0.1| = 0.4, weight 2/4
    # bin 0.9-1.0: p = 0.9, 1.0; y = 1, 1 -> |1 - 0.95| = 0.05, weight 2/4
    y = [0, 1, 1, 1]
    p = [0.1, 0.1, 0.9, 1.0]
    assert abs(ece(y, p) - (0.5 * 0.4 + 0.5 * 0.05)) < 1e-12


def test_ece_zero_when_perfectly_calibrated_bins():
    p = np.repeat([0.25, 0.75], 4)
    y = np.array([1, 0, 0, 0, 1, 1, 1, 0])
    assert ece(y, p) < 1e-12


def test_brier_and_auc():
    assert brier([0, 1], [0.0, 1.0]) == 0.0
    assert abs(brier([0, 1], [0.5, 0.5]) - 0.25) < 1e-12
    assert auc([0, 0, 1, 1], [0.1, 0.2, 0.3, 0.4]) == 1.0
    assert auc([1, 1], [0.1, 0.2]) is None
