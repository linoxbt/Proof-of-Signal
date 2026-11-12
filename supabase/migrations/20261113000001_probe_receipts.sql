-- Probe receipts, mobile ASNs, flag resolution (contracts/api.md).

-- One row per (nonce, SIM) upload that reached the probe. Ingest rejects an
-- upload.ok claim with no matching receipt, so a phone cannot fake a pass.
create table public.probe_receipts (
  nonce        text not null references public.nonces (nonce) on delete cascade,
  sim_slot     smallint not null check (sim_slot between 0 and 3),
  received_at  timestamptz not null default now(),
  bytes        integer not null check (bytes >= 0),
  duration_ms  integer not null check (duration_ms >= 0),
  client_ip    inet,      -- nulled after 24 h by purge_raw_gps()
  asn          integer,   -- from ip2asn when loaded; kept
  primary key (nonce, sim_slot)
);

-- Nigerian mobile operators' ASNs. From memory: verify against a current
-- ip2asn dump before relying on not_mobile_network rejections.
create table public.mobile_asns (
  asn       integer primary key,
  mcc       smallint not null,
  mnc       smallint not null,
  name      text not null,
  verified  boolean not null default false
);

insert into public.mobile_asns (asn, mcc, mnc, name) values
  (29465, 621, 30, 'MTN Nigeria'),
  (36873, 621, 20, 'Airtel Nigeria'),
  (37148, 621, 50, 'Globacom'),
  (37076, 621, 60, 'EMTS (9mobile)');

alter table public.probe_receipts enable row level security;
alter table public.mobile_asns enable row level security;
create policy mobile_asns_read on public.mobile_asns
  for select to anon, authenticated using (true);
revoke all on public.probe_receipts from anon, authenticated;
revoke insert, update, delete, truncate on public.mobile_asns from anon, authenticated;

-- A flag stays after its unit uploads; resolved_at records when.
alter table public.flags add column resolved_at timestamptz;

-- Offline runs: a phone with no connection cannot fetch a nonce, yet "no
-- connection" is a valid failure result. Such tests carry no nonce and may not
-- claim any upload.ok (enforced at ingest). Queued payloads can sync days
-- later, so ingest accepts an unused nonce issued within 7 days; the probe
-- still enforces the 5-minute window, and only a probe receipt makes a pass.
alter table public.tests alter column nonce drop not null;

create or replace function public.consume_nonce(p_nonce text, p_device_id uuid, p_max_age interval)
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
       and issued_at > now() - p_max_age
    returning 1
  )
  select exists (select 1 from used);
$$;
revoke execute on function public.consume_nonce(text, uuid, interval) from public, anon, authenticated;

-- Nonces (and their receipts) are kept 8 days after issue to cover queued sync.
create or replace function public.purge_raw_gps(p_older_than interval default interval '24 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tests int;
  v_votes int;
  v_ips int;
  v_nonces int;
begin
  update public.tests
     set fix = null, payload_raw = null, gps_purged_at = now()
   where gps_purged_at is null and received_at < now() - p_older_than;
  get diagnostics v_tests = row_count;

  update public.pu_location_votes
     set device_id = null
   where device_id is not null and created_at < now() - p_older_than;
  get diagnostics v_votes = row_count;

  update public.probe_receipts
     set client_ip = null
   where client_ip is not null and received_at < now() - p_older_than;
  get diagnostics v_ips = row_count;

  delete from public.nonces where issued_at < now() - interval '8 days';
  get diagnostics v_nonces = row_count;

  return jsonb_build_object('tests', v_tests, 'votes', v_votes, 'ips', v_ips, 'nonces', v_nonces);
end;
$$;
revoke execute on function public.purge_raw_gps(interval) from public, anon, authenticated;
