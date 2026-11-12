-- Coverage model outputs, elections and the frozen pre-election snapshot.
-- Election-night logic reads only frozen_predictions, so nobody can tune
-- coverage after seeing which units failed to upload.

create table public.model_versions (
  id               text primary key,                 -- e.g. 2026-12-08.1
  feature_version  text not null,
  trained_at       timestamptz not null default now(),
  -- AUC, Brier, ECE, interval coverage, both baselines, per state/carrier.
  metrics          jsonb not null default '{}'::jsonb,
  artefact_uri     text,
  artefact_sha256  text,
  is_current       boolean not null default false
);

create unique index model_versions_one_current on public.model_versions (is_current) where is_current;

create table public.features (
  pu_code          text not null references public.polling_units (pu_code) on delete cascade,
  mcc              smallint not null,
  mnc              smallint not null,
  feature_version  text not null,
  vector           jsonb not null,
  built_at         timestamptz not null default now(),
  primary key (pu_code, mcc, mnc, feature_version)
);

-- p_model: calibrated model prior. p, p_lo, p_hi: posterior after the
-- Beta-Binomial update with real tests (mean and 5th/95th percentiles),
-- or the conformal interval where the unit has no tests.
create table public.predictions (
  pu_code        text not null references public.polling_units (pu_code) on delete cascade,
  mcc            smallint not null,
  mnc            smallint not null,
  model_version  text not null references public.model_versions (id),
  p_model        numeric(5, 4) not null check (p_model between 0 and 1),
  p              numeric(5, 4) not null,
  p_lo           numeric(5, 4) not null,
  p_hi           numeric(5, 4) not null,
  n_tests        integer not null default 0,
  n_devices      integer not null default 0,
  n_evenings     integer not null default 0,
  measured       boolean not null default false,
  computed_at    timestamptz not null default now(),
  primary key (pu_code, mcc, mnc, model_version),
  check (0 <= p_lo and p_lo <= p and p <= p_hi and p_hi <= 1)
);

create index predictions_model_idx on public.predictions (model_version);

-- Current coverage per unit and carrier, for the public map and
-- GET /v1/coverage/{pu_code}.
create view public.coverage_current as
select pr.pu_code, pr.mcc, pr.mnc, c.name as carrier, pr.p, pr.p_lo, pr.p_hi,
       pr.n_tests, pr.n_devices, pr.n_evenings, pr.measured, pr.model_version, pr.computed_at
from public.predictions pr
join public.model_versions mv on mv.id = pr.model_version and mv.is_current
left join public.carriers c on c.mcc = pr.mcc and c.mnc = pr.mnc;

-- Best-carrier score: 1 - product of each carrier's failure probability,
-- assuming independence. Optimistic when one power cut takes down every
-- carrier on a shared mast; the model card must say so.
create view public.coverage_best_carrier as
select pu_code,
       round((1 - exp(sum(ln(greatest(1 - p, 1e-9)))))::numeric, 4)    as p_best,
       round((1 - exp(sum(ln(greatest(1 - p_lo, 1e-9)))))::numeric, 4) as p_best_lo,
       round((1 - exp(sum(ln(greatest(1 - p_hi, 1e-9)))))::numeric, 4) as p_best_hi,
       sum(n_tests)::integer as n_tests,
       count(*)::integer     as n_carriers,
       bool_or(measured)     as measured
from public.coverage_current
group by pu_code;

-- Watcher tunables, locked with the freeze. Defaults follow the spec, with
-- the three-cause plausibility (prior_other_q, neighbour_factor_r,
-- p_other_flag) proposed as a correction to the spec's two-cause formula.
create table public.elections (
  id              text primary key check (id ~ '^[a-z0-9-]+$'),
  name            text not null,
  election_date   date not null,
  state_codes     smallint[] not null,
  polls_close_at  timestamptz not null,
  is_replay       boolean not null default false,
  config          jsonb not null default '{
    "strong_cut": 0.8,
    "weak_cut": 0.4,
    "stall_window_min": 20,
    "stall_rate_frac": 0.1,
    "stall_pending_frac": 0.05,
    "stall_ratio_diff": 0.2,
    "not_measured_interval": 0.4,
    "p_network_plausible": 0.6,
    "p_other_flag": 0.6,
    "neighbour_min": 3,
    "prior_other_q": 0.05,
    "neighbour_factor_r": 0.3,
    "poll_interval_s": [120, 300]
  }'::jsonb,
  snapshot_id     uuid,
  created_at      timestamptz not null default now()
);

create table public.snapshots (
  id             uuid primary key default gen_random_uuid(),
  election_id    text not null references public.elections (id),
  model_version  text not null references public.model_versions (id),
  frozen_at      timestamptz not null default now(),
  config         jsonb not null,
  row_count      integer not null default 0,
  sha256         bytea,          -- set once by freeze_snapshot
  tsa_token      bytea,          -- RFC 3161 token, set once by the integrity service
  tsa_at         timestamptz
);

alter table public.elections
  add constraint elections_snapshot_fk foreign key (snapshot_id) references public.snapshots (id);

create table public.frozen_predictions (
  snapshot_id  uuid not null references public.snapshots (id),
  pu_code      text not null references public.polling_units (pu_code),
  mcc          smallint not null,
  mnc          smallint not null,
  p            numeric(5, 4) not null,
  p_lo         numeric(5, 4) not null,
  p_hi         numeric(5, 4) not null,
  n_tests      integer not null,
  n_devices    integer not null,
  n_evenings   integer not null,
  measured     boolean not null,
  primary key (snapshot_id, pu_code, mcc, mnc)
);

-- Frozen rows never change.
create trigger frozen_predictions_no_update
  before update or delete on public.frozen_predictions
  for each row execute function public.forbid_change();
create trigger frozen_predictions_no_truncate
  before truncate on public.frozen_predictions
  for each statement execute function public.forbid_change();

-- Snapshots are immutable once sha256 is set. Before that, freeze_snapshot may
-- set sha256 and row_count; afterwards only tsa_token and tsa_at may go from
-- null to a value.
create or replace function public.snapshots_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'snapshots cannot be deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.sha256 is null then
    -- Still being written by freeze_snapshot: only sha256 and row_count may change.
    if (new.id, new.election_id, new.model_version, new.frozen_at, new.config)
       is distinct from (old.id, old.election_id, old.model_version, old.frozen_at, old.config) then
      raise exception 'snapshot % is frozen', old.id using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.id, new.election_id, new.model_version, new.frozen_at, new.config, new.row_count, new.sha256)
     is distinct from
     (old.id, old.election_id, old.model_version, old.frozen_at, old.config, old.row_count, old.sha256)
     or (old.tsa_token is not null and new.tsa_token is distinct from old.tsa_token)
     or (old.tsa_at is not null and new.tsa_at is distinct from old.tsa_at) then
    raise exception 'snapshot % is frozen', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger snapshots_frozen
  before update or delete on public.snapshots
  for each row execute function public.snapshots_guard();

-- After the freeze an election's config and polls-close time are locked.
-- Re-freezing (spec: refreeze for Feb 6) is a new snapshot, which is allowed.
create or replace function public.elections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.snapshot_id is not null
     and (new.config is distinct from old.config
          or new.polls_close_at is distinct from old.polls_close_at
          or new.state_codes is distinct from old.state_codes)
     and new.snapshot_id is not distinct from old.snapshot_id then
    raise exception 'election % is frozen; take a new snapshot to change it', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger elections_frozen
  before update on public.elections
  for each row execute function public.elections_guard();

-- Canonical hash of a snapshot: its config, then one line per row in key order.
create or replace function public.snapshot_digest(p_snapshot_id uuid)
returns bytea
language sql
stable
set search_path = ''
as $$
  select extensions.digest(
    convert_to(
      (select s.election_id || '|' || s.model_version || '|' || s.config::text
         from public.snapshots s where s.id = p_snapshot_id)
      || E'\n' ||
      coalesce((
        select string_agg(concat_ws('|', pu_code, mcc, mnc, p, p_lo, p_hi,
                                    n_tests, n_devices, n_evenings, measured),
                          E'\n' order by pu_code, mcc, mnc)
        from public.frozen_predictions
        where snapshot_id = p_snapshot_id
      ), ''),
      'UTF8'),
    'sha256');
$$;

-- Freezes the given model version's predictions for an election's states.
create or replace function public.freeze_snapshot(p_election_id text, p_model_version text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_states smallint[];
  v_config jsonb;
  v_rows int;
  v_hash bytea;
begin
  select state_codes, config into v_states, v_config
  from public.elections where id = p_election_id
  for update;
  if v_states is null then
    raise exception 'unknown election %', p_election_id;
  end if;

  insert into public.snapshots (election_id, model_version, config)
  values (p_election_id, p_model_version, v_config)
  returning id into v_id;

  insert into public.frozen_predictions
    (snapshot_id, pu_code, mcc, mnc, p, p_lo, p_hi, n_tests, n_devices, n_evenings, measured)
  select v_id, pr.pu_code, pr.mcc, pr.mnc, pr.p, pr.p_lo, pr.p_hi,
         pr.n_tests, pr.n_devices, pr.n_evenings, pr.measured
  from public.predictions pr
  join public.polling_units pu on pu.pu_code = pr.pu_code
  where pr.model_version = p_model_version
    and pu.state_code = any (v_states);
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'model % has no predictions for election %', p_model_version, p_election_id;
  end if;

  v_hash := public.snapshot_digest(v_id);
  update public.snapshots set sha256 = v_hash, row_count = v_rows where id = v_id;
  update public.elections set snapshot_id = v_id where id = p_election_id;

  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'freeze', 'snapshots', v_id::text,
          jsonb_build_object('election_id', p_election_id, 'model_version', p_model_version,
                             'rows', v_rows, 'sha256', encode(v_hash, 'hex')));
  return v_id;
end;
$$;

create or replace function public.snapshot_verify(p_snapshot_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select s.sha256 = public.snapshot_digest(s.id) from public.snapshots s where s.id = p_snapshot_id;
$$;

alter table public.model_versions enable row level security;
alter table public.features enable row level security;
alter table public.predictions enable row level security;
alter table public.elections enable row level security;
alter table public.snapshots enable row level security;
alter table public.frozen_predictions enable row level security;

-- Coverage is public (the Method page publishes snapshot hashes too).
create policy model_versions_read on public.model_versions
  for select to anon, authenticated using (true);
create policy predictions_read on public.predictions
  for select to anon, authenticated using (true);
create policy elections_read on public.elections
  for select to anon, authenticated using (true);
create policy snapshots_read on public.snapshots
  for select to anon, authenticated using (true);
create policy frozen_predictions_read on public.frozen_predictions
  for select to anon, authenticated using (true);
-- features: service role only.

revoke insert, update, delete, truncate on public.model_versions, public.features,
  public.predictions, public.elections, public.snapshots, public.frozen_predictions
  from anon, authenticated;
revoke select on public.features from anon, authenticated;
grant select on public.coverage_current, public.coverage_best_carrier to anon, authenticated;
