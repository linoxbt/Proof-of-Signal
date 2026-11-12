"""Scoring: AUC, Brier, expected calibration error (ECE), log loss."""

from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score

from .config import ECE_BINS


def ece(y, p, n_bins: int = ECE_BINS) -> float:
    """Expected calibration error with equal-width bins on [0, 1]:
    sum over bins of (n_bin / n) * |mean(y) - mean(p)|. p = 1.0 falls in the last bin."""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    if len(y) == 0:
        return float("nan")
    b = np.minimum((p * n_bins).astype(int), n_bins - 1)
    total = 0.0
    for k in range(n_bins):
        m = b == k
        if m.any():
            total += m.sum() / len(y) * abs(y[m].mean() - p[m].mean())
    return float(total)


def brier(y, p) -> float:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    return float(np.mean((p - y) ** 2))


def auc(y, p) -> float | None:
    y = np.asarray(y)
    if len(np.unique(y)) < 2:
        return None
    return float(roc_auc_score(y, p))


def log_loss(y, p, eps: float = 1e-6) -> float:
    y = np.asarray(y, dtype=float)
    p = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def score(y, p) -> dict:
    return {
        "n": int(len(y)),
        "base_rate": float(np.mean(y)) if len(y) else None,
        "auc": auc(y, p),
        "brier": brier(y, p),
        "ece": ece(y, p),
        "log_loss": log_loss(y, p),
    }
