-- Add stall_min_expected to the watcher tunables so it is frozen with the
-- rest (contracts/api.md, "System stall"). Existing elections without it
-- fall back to the watcher's default of 10.
alter table public.elections alter column config set default '{
  "strong_cut": 0.8,
  "weak_cut": 0.4,
  "stall_window_min": 20,
  "stall_rate_frac": 0.1,
  "stall_pending_frac": 0.05,
  "stall_ratio_diff": 0.2,
  "stall_min_expected": 10,
  "not_measured_interval": 0.4,
  "p_network_plausible": 0.6,
  "p_other_flag": 0.6,
  "neighbour_min": 3,
  "prior_other_q": 0.05,
  "neighbour_factor_r": 0.3,
  "poll_interval_s": [120, 300]
}'::jsonb;

update public.elections
   set config = config || '{"stall_min_expected": 10}'::jsonb
 where snapshot_id is null and not config ? 'stall_min_expected';
