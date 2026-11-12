"""Constants shared across the model service. Values follow the build spec."""

from __future__ import annotations

import os
from pathlib import Path

# Bump when the meaning or set of features changes; stored in features.feature_version.
FEATURE_VERSION = "fv1"

MCC_NIGERIA = 621

# Label window and "measured" rule live in the database (tests.is_evening,
# pu_carrier_evidence); these mirror them for synthetic data and docs.
UPLOAD_LIMIT_MS = 600_000
MEASURED_MIN_TESTS = 3
MEASURED_MIN_DEVICES = 2
MEASURED_MIN_EVENINGS = 2

# Tower features.
TOWER_COUNT_RADII_M = (2_000, 5_000, 10_000)
SITE_DEDUPE_DECIMALS = 4  # cells within ~11 m of each other count as one site/mast

# Terrain / line of sight.
LOS_STEP_M = 30.0
LOS_MAX_SAMPLES = 1500  # beyond 45 km the step grows to keep the cost bounded
PU_ANTENNA_M = 1.5      # phone held at chest height
TOWER_ANTENNA_M = 30.0  # OpenCellID has no mast height; typical Nigerian macro mast
EARTH_RADIUS_M = 6_371_008.8
REFRACTION_K = 4.0 / 3.0  # standard atmosphere effective-Earth factor

# Settlement features.
SETTLEMENT_RADIUS_M = 1_000
POPULATION_RADIUS_M = 2_000
URBAN_POP_2KM = 20_000  # urban if built-up or at least this many people within 2 km

# Crowd QoS (Ookla open data, mobile).
OOKLA_ZOOM = 16
OOKLA_QUARTERS = 4

# Spatial context.
CONTEXT_K = 5

# Model.
CV_FOLDS = 5
H3_RES = 6
RANDOM_SEED = 20261112
CONFORMAL_ALPHA = 0.10  # 90 % intervals
CONFORMAL_MIN_TESTS = 3  # unit-carriers used as calibration points
CONFORMAL_SCALE_FLOOR = 0.05
P_CLIP = (0.005, 0.995)
ECE_TARGET = 0.08
ECE_BINS = 10

# Beta-Binomial update.
PRIOR_PSEUDO_TESTS = 4.0
POSTERIOR_LO_Q = 0.05
POSTERIOR_HI_Q = 0.95

# Outlier re-weighting of upload times.
OUTLIER_MAD_K = 3.0
OUTLIER_MAD_SCALE = 1.4826  # MAD -> standard deviation for a normal distribution
OUTLIER_MIN_GROUP = 4
OUTLIER_FACTOR = 0.2

REPO_ROOT = Path(__file__).resolve().parents[3]


def sources_dir() -> Path:
    """Processed source files (dem.tif, population.tif, settlements.parquet, ookla_mobile.parquet)."""
    return Path(os.environ.get("POS_SOURCES_DIR", REPO_ROOT / "data" / "cache" / "sources"))


def artefact_dir() -> Path:
    return Path(os.environ.get("POS_ARTEFACT_DIR", REPO_ROOT / "data" / "cache" / "models"))
