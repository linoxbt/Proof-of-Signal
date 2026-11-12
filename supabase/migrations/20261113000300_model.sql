-- Coverage model: idempotent outlier re-weighting of test trust.
--
-- The model service down-weights accepted tests whose upload time is beyond
-- 3 scaled MADs of their unit's carrier median (trust x 0.2, spec: "Per-PU
-- robust outlier re-weighting"). To make re-runs idempotent and reversible
-- when later tests move the median, the pre-outlier trust is kept here:
--   flagged:   trust_pre_outlier := trust, trust := round(0.2 * trust_pre_outlier, 3)
--   unflagged: trust := trust_pre_outlier, trust_pre_outlier := null
-- Ingest never sets these columns (outlier factor 1.0 at ingest).

alter table public.tests
  add column trust_pre_outlier numeric(4, 3) check (trust_pre_outlier between 0 and 1),
  add column outlier_reweighted_at timestamptz,
  add constraint tests_outlier_consistent
    check ((trust_pre_outlier is null) = (outlier_reweighted_at is null));

comment on column public.tests.trust_pre_outlier is
  'Trust before the model service''s outlier factor (0.2) was applied; null when not an outlier.';
