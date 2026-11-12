"""Per-unit robust outlier detection on upload times.

Within each (unit, carrier), log upload times of accepted tests that have a
total_ms are compared with the group median. A test SIM is an outlier when

    |log t - median(log t)| > 3 * 1.4826 * MAD(log t)

(1.4826 * MAD estimates the standard deviation under normality, so this is a
robust 3-sigma rule). Groups with fewer than 4 times or MAD = 0 are skipped.
A test is down-weighted if any of its SIMs is an outlier: its trust becomes
0.2 x its pre-outlier trust (pipeline.reweight_outliers stores the original
in tests.trust_pre_outlier so re-runs are idempotent and reversible).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import OUTLIER_MAD_K, OUTLIER_MAD_SCALE, OUTLIER_MIN_GROUP


def flag_outliers(rows: pd.DataFrame, k: float = OUTLIER_MAD_K, scale: float = OUTLIER_MAD_SCALE,
                  min_group: int = OUTLIER_MIN_GROUP) -> set:
    """rows: test_id, pu_code, mnc, total_ms. Returns the set of outlier test ids."""
    r = rows.dropna(subset=["total_ms"])
    r = r[r["total_ms"] > 0]
    out: set = set()
    for _, g in r.groupby(["pu_code", "mnc"]):
        if len(g) < min_group:
            continue
        lt = np.log(g["total_ms"].to_numpy(dtype=float))
        med = np.median(lt)
        mad = np.median(np.abs(lt - med))
        if mad <= 0:
            continue
        bad = np.abs(lt - med) > k * scale * mad
        out.update(g["test_id"].to_numpy()[bad].tolist())
    return out
