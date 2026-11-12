# Coverage model (Python 3.12)

LightGBM with monotone constraints, spatial block CV on H3 res-6 cells, isotonic calibration, MAPIE conformal intervals, Beta-Binomial update (k = 4) for measured units. Reads `pu_carrier_evidence` and `features`; writes `model_versions` and `predictions`. Freezing calls `freeze_snapshot(election_id, model_version)`. Not written yet.
