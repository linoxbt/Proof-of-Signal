"""Spatial block cross-validation on H3 cells.

Every unit is assigned to the H3 cell (resolution 6, ~36 km^2) containing it;
whole cells go to folds, so no cell (and therefore no unit, and no test of a
unit) is ever on both sides of a split.
"""

from __future__ import annotations

import h3
import numpy as np
import pandas as pd

from .config import CV_FOLDS, H3_RES, RANDOM_SEED


def h3_blocks(lat, lng, res: int = H3_RES) -> np.ndarray:
    return np.array([h3.latlng_to_cell(float(a), float(b), res) for a, b in zip(lat, lng)], dtype=object)


def assign_folds(blocks, weights=None, n_folds: int = CV_FOLDS, seed: int = RANDOM_SEED) -> dict:
    """Map block -> fold. Greedy balancing: blocks in random order, heaviest
    first, each to the currently lightest fold. Deterministic for a seed."""
    blocks = np.asarray(blocks, dtype=object)
    w = np.ones(len(blocks)) if weights is None else np.asarray(weights, dtype=float)
    tot = pd.Series(w).groupby(blocks).sum()
    rng = np.random.default_rng(seed)
    order = tot.index.to_numpy()[rng.permutation(len(tot))]
    order = sorted(order, key=lambda b: -tot[b])  # stable: ties keep the random order
    load = np.zeros(n_folds)
    out = {}
    for b in order:
        f = int(np.argmin(load))
        out[b] = f
        load[f] += tot[b]
    return out


def unit_folds(units: pd.DataFrame, rows_per_unit: pd.Series | None = None,
               n_folds: int = CV_FOLDS, seed: int = RANDOM_SEED, res: int = H3_RES) -> pd.DataFrame:
    """units: pu_code, lat, lng. Returns pu_code, block, fold."""
    u = units[["pu_code", "lat", "lng"]].drop_duplicates("pu_code").reset_index(drop=True)
    u["block"] = h3_blocks(u["lat"], u["lng"], res)
    w = None
    if rows_per_unit is not None:
        w = u["pu_code"].map(rows_per_unit).fillna(0).to_numpy() + 1e-9
    fmap = assign_folds(u["block"].to_numpy(), w, n_folds, seed)
    u["fold"] = u["block"].map(fmap).astype(int)
    return u[["pu_code", "block", "fold"]]
