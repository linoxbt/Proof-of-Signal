# Model card: Proof of Signal coverage model

> **Every number on this card comes from a SYNTHETIC run.** The demo world is invented: state code 99, synthetic towers, terrain, settlements, Ookla tiles and volunteer tests drawn from a known ground-truth function. No real Nigerian data has been used yet. Replace the tables once a real model version is trained. Its `model_versions.metrics` holds the same fields.

## Model details

| | |
| --- | --- |
| Code | `services/model` (`pos-model`), feature version `fv1` |
| Type | LightGBM binary classifier: one model for all carriers, carrier (MNC) as a categorical feature, 300 rounds, 15 leaves |
| Constraints | Non-increasing in distance to the 1st, 2nd and 3rd nearest site and in line-of-sight obstruction to each of them |
| Calibration | Isotonic regression on out-of-fold predictions |
| Intervals | Split-conformal, 90 %, normalised score, spatial out-of-fold calibration set |
| Measured units | Beta-Binomial update: the prior is worth 4 pseudo-tests at the model's p, and each accepted test adds its trust weight. The published interval is the 5th to 95th percentile |
| Validation | Spatial block CV, 5 folds, on H3 resolution-6 cells |
| Synthetic run | `pos-model demo --seed 7 --n-pus 1000` on the dev database, model version `2026-11-12.1` |

## What it predicts

The output is the probability that a 1.5 MB upload completes within 10 minutes between 17:00 and 23:59 WAT, from a phone at the polling unit, on a given carrier (`predictions.p`). The best-carrier score is 1 − Π(1 − p_carrier) (`coverage_best_carrier`).

**Intended use**: the Transmission Risk Register, the public coverage map, and the election-night watcher's prior that a missing IReV upload is explained by the network.

**Not intended for** judging an individual polling unit's officials. It is not evidence of malpractice. It says nothing about vote figures.

## Training data (synthetic run)

| | |
| --- | --- |
| Units | 1,000 synthetic plus the 5 seed units, giving 1,005 units × 4 carriers = 4,020 predictions |
| Towers | 774 cells (GSM/UMTS/LTE/NR); MTN 70, Airtel 50, Glo 35 and 9mobile 12 sites; some masts shared |
| Tests | 2,454 accepted tests (evening and daytime) from 60 devices; 3,167 evening (test, SIM) label rows across 505 units, 1,438 unit-carriers and 112 H3 blocks |
| Outliers | 83 tests re-weighted to 0.2 × trust. The generator plants about 3 % implausibly fast uploads among the successes |
| Ground truth | sigmoid(2.4 + carrier − 1.4 ln(1 + d1/1 km) − 0.07·obs1 + 0.6·share4G/5G + 0.9·field − 0.5·congestion). The field is a smooth random field that only the spatial-context features can see |

## Metrics (synthetic, out-of-fold, 3,167 rows, base rate 0.544)

| | AUC | Brier | ECE | Log loss |
| --- | --- | --- | --- | --- |
| **Model (calibrated, cross-fitted)** | **0.763** | **0.192** | **0.019** | **0.566** |
| Model before calibration | 0.773 | 0.192 | 0.053 | 0.567 |
| Baseline (a): logistic on tower distance | 0.712 | 0.216 | 0.067 | 0.624 |
| Baseline (b): logistic on Ookla tile | 0.717 | 0.215 | 0.041 | 0.622 |
| Oracle: the true p (synthetic only) | 0.821 | 0.170 | 0.015 | 0.507 |

ECE target ≤ 0.08: **met** (0.019).

The calibrated model's AUC (0.763) is below the uncalibrated model's (0.773). Isotonic calibration produces ties, and cross-fitting adds noise from map to map. Brier and log loss do not degrade.

By carrier (out-of-fold AUC):

| MNC | Rows | Model AUC | Brier | ECE | Distance baseline AUC | Ookla baseline AUC |
| --- | --- | --- | --- | --- | --- | --- |
| 30 MTN | 1,286 | 0.719 | 0.192 | 0.037 | 0.682 | **0.736** |
| 20 Airtel | 988 | 0.723 | 0.206 | 0.056 | 0.670 | 0.710 |
| 50 Glo | 635 | 0.772 | 0.192 | 0.047 | 0.709 | 0.747 |
| 60 9mobile | 258 | 0.825 | 0.132 | 0.069 | 0.775 | 0.699 |

Within MTN, the Ookla-only baseline ranks units slightly better than the model. In the synthetic world, tile speed follows a market-share-weighted quality that MTN dominates. The model wins overall partly through the carrier effect. On real data, the per-carrier comparison is the one to watch.

**Intervals.** The conformal quantile is q = 0.848, from 457 unit-carriers with 3 or more tests. Coverage of held-out units' observed success rates is 0.891 in cross-fold estimation, against a nominal 0.90. The mean width is 0.68.

The published intervals are wide:

| Units | Mean interval width |
| --- | --- |
| No tests | 0.65 |
| Some tests, not measured | 0.53 |
| Measured | 0.50 |

594 of 1,005 units have a best-carrier interval wider than 0.4, so the watcher would class them `NOT_MEASURED`. The calibration targets are observed rates from 3 to 10 trust-weighted tests, so binomial noise dominates the width. The intervals are therefore conservative for the true rate.

## Known limits

1. **The best-carrier score assumes carriers fail independently.** One power cut or backhaul fault on a shared mast takes every carrier down together, so 1 − Π(1 − p) is optimistic. In the synthetic run, 807 of 1,005 units have a best-carrier score of 0.8 or more.
2. **Conditions on the day are invisible.** Election-day congestion, tower power cuts, diesel shortages, network shutdowns and BVAS or IReV faults are not in the training data. The evening label window approximates load, but not election-day load.
3. **Rural units lean on the model.** Volunteers reach towns first, so measured units cluster where coverage is good. Unmeasured rural units rely on the features and the spatial context of distant neighbours. Their intervals are wide, and they should be treated as `NOT_MEASURED`, not as confident predictions.
4. **Spatial leakage across block edges.** H3 res-6 blocks are about 3.2 km across. Units on either side of a block edge are correlated, so CV scores can still be slightly optimistic.
5. **Tower data quality.** OpenCellID positions are crowd-estimated centroids, not mast locations. Masts are assumed to be 30 m high because no height is published. Co-located cells (within about 11 m) count as one site. Carrier MNCs are unverified until checked against OpenCellID (`data/opencellid.py load --verify-carriers`).
6. **Crowd QoS is coarse.** Ookla publishes per-tile averages (`avg_u_kbps`), not medians. The feature is a test-weighted median of tile averages over all carriers, and tests come mostly from towns. Ookla data is CC BY-NC-SA, so non-commercial use only.
7. **Settlements are approximate.** "Built-up" uses the equal-area circle of a GRID3 extent's centroid, not point-in-polygon.
8. **Labels depend on trust.** Device reputation, place score and the outlier factor weight each test. A coordinated group of devices with good reputations could still bias a unit. Measured requires 2 or more devices on 2 or more evenings, which limits a single device's influence.
9. **The synthetic ground truth is learnable by construction.** The model's inputs determine it, apart from the hidden field and Bernoulli noise. Real coverage will be harder. Expect lower AUC.

## Ethical considerations

The model only ever sees signal and upload tests. It never sees votes, voters or results. Raw GPS is purged after 24 hours, and features use unit locations, not volunteer fixes. Predictions are frozen with a sha256 (`freeze_snapshot`) before election day, so nobody can tune coverage after seeing which units failed to upload. A flag is a request for human review, not a finding.
