-- Devices, nonces and signed test submissions.
-- Written only by the ingest Edge Functions (service role). No dashboard user
-- reads raw tests: the dashboard reads predictions and evidence views.

create table public.devices (
  id                    uuid primary key default gen_random_uuid(),
  pubkey                text not null unique,  -- base64 SPKI of the Keystore ES256 key
  key_alg               text not null default 'ES256' check (key_alg = 'ES256'),
  integrity_level       text,                  -- Play Integrity device verdict at onboarding
  integrity_checked_at  timestamptz,
  -- Starts at 0.5, rises with tests that agree with independent devices.
  reputation            numeric(4, 3) not null default 0.5 check (reputation between 0 and 1),
  status                public.device_status not null default 'active',
  status_reason         text,
  app_version           text,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz
);

-- Opt-in only, for airtime rewards. Stored apart from tests and devices'
-- other fields, deleted with the device.
create table public.airtime_contacts (
  device_id   uuid primary key references public.devices (id) on delete cascade,
  msisdn      text not null check (msisdn ~ '^\+234\d{10}$'),
  consent_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Single-use server nonces, valid for 5 minutes (GET /v1/nonce).
create table public.nonces (
  nonce       text primary key,
  device_id   uuid not null references public.devices (id) on delete cascade,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '5 minutes',
  used_at     timestamptz
);

create index nonces_expires_idx on public.nonces (expires_at);

-- Marks a nonce used. True only for an unused, unexpired nonce issued to
-- this device; any replay or late use returns false.
create or replace function public.consume_nonce(p_nonce text, p_device_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with used as (
    update public.nonces
       set used_at = now()
     where nonce = p_nonce
       and device_id = p_device_id
       and used_at is null
       and expires_at > now()
    returning 1
  )
  select exists (select 1 from used);
$$;

create table public.tests (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references public.devices (id) on delete cascade,
  pu_code         text not null references public.polling_units (pu_code),
  nonce           text not null unique,
  captured_at     timestamptz not null,           -- payload `ts`
  received_at     timestamptz not null default now(),
  -- Set by trigger from captured_at in WAT (UTC+1, no DST).
  local_date      date not null,
  is_evening      boolean not null,               -- 17:00 to 23:59 WAT: label window
  -- Raw GPS: kept 24 hours, then nulled by purge_raw_gps().
  fix             extensions.geography(Point, 4326),
  acc_m           real not null check (acc_m > 0),
  mock            boolean not null,
  dist_to_pu_m    real,
  geohash7        text not null,                  -- about 150 m, kept after the purge
  app_version     text not null,
  payload_sha256  bytea not null unique,          -- dedupe of identical submissions
  signature       text not null,
  payload_raw     jsonb,                          -- nulled with the fix after 24 h
  gps_purged_at   timestamptz,
  -- Product of device reputation, place-check score and outlier factor.
  trust           numeric(4, 3) not null default 0 check (trust between 0 and 1),
  status          public.test_status not null,
  reject_reason   text,
  check (captured_at <= received_at + interval '10 minutes'),
  check (status = 'accepted' or reject_reason is not null),
  check (gps_purged_at is not null or fix is not null)
);

create index tests_pu_idx on public.tests (pu_code, status);
create index tests_device_idx on public.tests (device_id, captured_at);
create index tests_purge_idx on public.tests (received_at) where gps_purged_at is null;

-- One row per (test, SIM): the unit the model trains on.
create table public.test_sims (
  test_id       uuid not null references public.tests (id) on delete cascade,
  sim_slot      smallint not null check (sim_slot between 0 and 3),
  mcc           smallint not null,
  mnc           smallint not null,
  net_type      text,
  latency_ms    integer[],
  upload_ok     boolean not null,
  upload_bytes  integer,
  dns_ms        integer,
  connect_ms    integer,
  tls_ms        integer,
  ttfb_ms       integer,
  total_ms      integer,
  http_status   smallint,
  err           text,
  -- Label: 1.5 MB upload succeeded within 10 minutes.
  success       boolean generated always as (upload_ok and coalesce(total_ms <= 600000, false)) stored,
  primary key (test_id, sim_slot)
);

create index test_sims_carrier_idx on public.test_sims (mcc, mnc);

create table public.test_cells (
  id          bigint generated always as identity primary key,
  test_id     uuid not null,
  sim_slot    smallint not null,
  sample_idx  smallint not null default 0 check (sample_idx between 0 and 9),
  reg         boolean not null,
  radio       public.radio_type not null,
  mcc         smallint,
  mnc         smallint,
  area        integer,
  cid         bigint,
  pci         smallint,
  earfcn      integer,
  rsrp        smallint,
  rsrq        smallint,
  rssnr       smallint,
  rssi        smallint,
  ta          smallint,
  level       smallint check (level between 0 and 4),
  foreign key (test_id, sim_slot) references public.test_sims (test_id, sim_slot) on delete cascade
);

create index test_cells_test_idx on public.test_cells (test_id, sim_slot);
create index test_cells_cell_idx on public.test_cells (radio, mcc, mnc, area, cid) where reg;

alter table public.pu_location_votes
  add constraint pu_location_votes_device_fk
    foreign key (device_id) references public.devices (id) on delete cascade,
  add constraint pu_location_votes_test_fk
    foreign key (test_id) references public.tests (id) on delete set null;

-- Derived fields and the per-device daily cap (3 accepted tests per device
-- per unit per day; extras are quarantined, never counted).
create or replace function public.tests_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_local timestamp := (new.captured_at at time zone 'UTC') + interval '1 hour';
  v_pu extensions.geography;
begin
  new.local_date := v_local::date;
  new.is_evening := v_local::time >= time '17:00';

  if new.fix is not null then
    new.geohash7 := extensions.st_geohash(new.fix::extensions.geometry, 7);
    select geom into v_pu from public.polling_units where pu_code = new.pu_code;
    if v_pu is not null then
      new.dist_to_pu_m := extensions.st_distance(new.fix, v_pu);
    end if;
  end if;

  if new.status = 'accepted' and (
    select count(*) from public.tests t
    where t.device_id = new.device_id
      and t.pu_code = new.pu_code
      and t.local_date = new.local_date
      and t.status = 'accepted'
  ) >= 3 then
    new.status := 'quarantined';
    new.reject_reason := 'daily_cap';
  end if;

  return new;
end;
$$;

create trigger tests_derive
  before insert on public.tests
  for each row execute function public.tests_before_insert();

-- Evidence per unit and carrier from accepted evening tests (the label
-- window). `measured` is the spec's rule: 3+ tests, 2+ devices, 2+ evenings.
create view public.pu_carrier_evidence
with (security_invoker = true) as
select
  t.pu_code,
  s.mcc,
  s.mnc,
  count(*)                                   as n_tests,
  count(distinct t.device_id)                as n_devices,
  count(distinct t.local_date)               as n_evenings,
  coalesce(sum(t.trust) filter (where s.success), 0)     as w_success,
  coalesce(sum(t.trust) filter (where not s.success), 0) as w_failure,
  (count(*) >= 3
     and count(distinct t.device_id) >= 2
     and count(distinct t.local_date) >= 2)  as measured
from public.tests t
join public.test_sims s on s.test_id = t.id
where t.status = 'accepted' and t.is_evening
group by t.pu_code, s.mcc, s.mnc;

-- DELETE /v1/devices/{id}/data. Removes the device and, by cascade, its
-- tests, SIM rows, cell rows, nonces, location votes and airtime contact.
-- Predictions are recomputed on the next model run.
create or replace function public.erase_device_data(p_device_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tests int;
begin
  select count(*) into v_tests from public.tests where device_id = p_device_id;
  delete from public.devices where id = p_device_id;
  if not found then
    return null;
  end if;
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (null, 'erase', 'devices', p_device_id::text, jsonb_build_object('tests_deleted', v_tests));
  return v_tests;
end;
$$;

-- Device status changes (quarantine, ban) are audited.
create trigger devices_status_audit
  after update of status on public.devices
  for each row when (old.status is distinct from new.status)
  execute function public.audit_row('id');

alter table public.devices enable row level security;
alter table public.airtime_contacts enable row level security;
alter table public.nonces enable row level security;
alter table public.tests enable row level security;
alter table public.test_sims enable row level security;
alter table public.test_cells enable row level security;
-- No policies: service role only.

revoke all on public.devices, public.airtime_contacts, public.nonces, public.tests,
  public.test_sims, public.test_cells, public.pu_carrier_evidence from anon, authenticated;
revoke execute on function public.consume_nonce(text, uuid) from public, anon, authenticated;
revoke execute on function public.erase_device_data(uuid) from public, anon, authenticated;
