# Coverage model (`pos-model`)

Predicts, for every polling unit and carrier, the probability that a 1.5 MB upload succeeds within 10 minutes between 17:00 and 23:59 WAT. The model is LightGBM with monotone constraints, validated with spatial block CV on H3 res-6 cells, calibrated with isotonic regression, and given split-conformal intervals. Units with real tests get a Beta-Binomial update (k = 4). It reads `polling_units`, `cells`, `tests`/`test_sims` and `pu_carrier_evidence`. It writes `features`, `model_versions` and `predictions`, and the `freeze` command calls `freeze_snapshot()`. Model card: [`docs/model-card.md`](../../docs/model-card.md).

## Setup

```sh
cd services/model
python3 -m venv .venv
.venv/bin/pip install -e '.[data,dev]'
```

## Commands

Every command uses `DATABASE_URL`, connecting as a role that bypasses RLS, and prints JSON.

| Command | What it does |
| --- | --- |
| `pos-model features [--sources DIR]` | Builds the feature vector for every (unit, carrier) and replaces `features` rows of `fv1`. Sources are `dem.tif`/`dem.vrt`, `population.tif`, `settlements.parquet` and `ookla_mobile.parquet` in `data/cache/sources/`, as written by the `data/` scripts. If a source is missing, its features are null and a warning is printed. |
| `pos-model reweight` | Outlier re-weighting (below). Idempotent. |
| `pos-model train` | Re-weights, then runs spatial CV, baselines, calibration and conformal intervals, then fits the final model. It writes the artefact (`data/cache/models/<version>/model.txt` plus `artefact.json`, no pickles) and inserts `model_versions` with the metrics and sha256. |
| `pos-model predict [--model-version V]` | Checks the artefact sha256, writes `predictions` and sets `is_current`. |
| `pos-model freeze --election ID [--model-version V]` | Calls `freeze_snapshot(ID, V)`, with `V` defaulting to the current version, and reports the snapshot sha256 and `snapshot_verify`. |
| `pos-model demo [--n-pus 1000] [--freeze replay-demo]` | **Dev databases only.** Inserts the synthetic world: state 99, LGAs 02–07, around 2,450 tests marked `app_version = 'synthetic-demo'`. It then runs the whole pipeline so the dashboard and watcher have realistic predictions. |

```sh
PGDEV_PORT=54332 scripts/db-dev.sh start          # prints DATABASE_URL
export DATABASE_URL=postgresql://postgres@127.0.0.1:54332/pos_dev
services/model/.venv/bin/pos-model demo --freeze replay-demo
```

## Method, in short

- **Label**: one row per accepted evening (test, SIM). `test_sims.success` means the upload completed and `total_ms ≤ 600000`. The row is weighted by `tests.trust`. Daytime tests feed only the `day_n`/`day_rate` features.
- **Features**: see `pos_model/features.py`, which documents each one. Co-located cells are merged into sites before tower distances and counts are computed. Line of sight goes from 1.5 m above the unit to 30 m above the tower. It is sampled every 30 m with an Earth bulge at k = 4/3. "Built-up" means the unit lies within the equal-area circle of a GRID3 built-up extent. The Ookla value is the test-weighted median of the tile averages over the 9 tiles and latest 4 quarters. Units with no point use their ward centroid (or LGA centroid) and get `loc_imputed = 1`.
- **Spatial context** is computed out of fold. In CV fold *f*, neighbours come only from measured units outside fold *f*. Deployment features use every other measured unit.
- **Monotone constraints**: the model is non-increasing in `d1_m`, `d2_m`, `d3_m`, `obs1_m`, `obs2_m` and `obs3_m`. Isotonic calibration preserves this.
- **Metrics** use cross-fitted calibration: each fold is calibrated by an isotonic map fitted on the other folds. The reported metrics are AUC, Brier, ECE (10 bins, target ≤ 0.08) and log loss, for the model and for two baselines: logistic regression on log tower distance, and logistic regression on the Ookla tile. They are also broken down by state and by carrier.
- **Intervals**: the score is `|r − p| / (sqrt(p(1−p)) + 0.05)` on unit-carriers with 3 or more tests, using out-of-fold `p`. The 90 % quantile uses the finite-sample correction. Coverage is estimated across folds.
- **Published values**: for units with no tests, `p = p_model` and the conformal interval. For units with accepted evening tests, the posterior Beta(4·p_model + Σw·success, 4·(1−p_model) + Σw·failure) gives the mean and its 5th and 95th percentiles. For trained units, `p_model` is their out-of-fold prediction, so their own tests are not counted twice. `measured` comes from `pu_carrier_evidence`: 3+ tests, 2+ devices and 2+ evenings.
- **Outlier re-weighting**: within a (unit, carrier), an accepted test is an outlier if `|log t − median| > 3 × 1.4826 × MAD`, using `total_ms` and only groups with at least 4 times and MAD > 0. An outlier test gets `trust = 0.2 × trust_pre_outlier`. Migration `20261113000300_model.sql` adds `tests.trust_pre_outlier` and `outlier_reweighted_at`, so re-runs do not compound and a test is restored once it stops being an outlier. Each change is written to `audit_log` (`outlier_reweight`).

## Tests

```sh
cd services/model
.venv/bin/pytest -q                                                     # unit tests (DB tests skip without a URL)
POS_MODEL_TEST_DB_URL=postgresql://postgres@127.0.0.1:54332/pos_dev .venv/bin/pytest -q   # + end-to-end on a throwaway DB
```

The DB tests create `pos_model_test_<pid>` on that server and apply the stub, every migration and the seed with `psql`. They run the demo and drop the database afterwards. The suite covers:

- end-to-end run, views and freeze;
- no H3 block in two folds;
- out-of-fold context never using the validation fold;
- monotonicity over grids of every constrained feature;
- ECE and conformal maths and coverage;
- Beta-Binomial against numeric integration;
- idempotent and reversible re-weighting;
- the model beating both baselines on synthetic data;
- loaders and the PU-code normaliser.
