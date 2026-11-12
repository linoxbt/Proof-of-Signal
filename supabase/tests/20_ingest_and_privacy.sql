-- Nonces, derived test fields, daily cap, evidence view, GPS purge, erasure,
-- crowd location consensus, and that the public cannot read raw tests.

insert into public.devices (id, pubkey, integrity_level) values
  ('00000000-0000-0000-0000-0000000d0001', 'pk-device-1', 'MEETS_DEVICE_INTEGRITY'),
  ('00000000-0000-0000-0000-0000000d0002', 'pk-device-2', 'MEETS_DEVICE_INTEGRITY'),
  ('00000000-0000-0000-0000-0000000d0003', 'pk-device-3', 'MEETS_DEVICE_INTEGRITY');

insert into public.nonces (nonce, device_id) values
  ('n-ok', '00000000-0000-0000-0000-0000000d0001'),
  ('n-expired', '00000000-0000-0000-0000-0000000d0001');
update public.nonces set expires_at = now() - interval '1 minute' where nonce = 'n-expired';

do $$
begin
  if not public.consume_nonce('n-ok', '00000000-0000-0000-0000-0000000d0001') then
    raise exception 'FAIL: fresh nonce refused';
  end if;
  if public.consume_nonce('n-ok', '00000000-0000-0000-0000-0000000d0001') then
    raise exception 'FAIL: nonce replay accepted';
  end if;
  if public.consume_nonce('n-expired', '00000000-0000-0000-0000-0000000d0001') then
    raise exception 'FAIL: expired nonce accepted';
  end if;
end;
$$;

-- Helper for this test file only: one accepted single-SIM test.
create function pg_temp.add_test(
  p_device uuid, p_pu text, p_at timestamptz, p_ok boolean, p_total_ms int,
  p_lng float8 default 4.5501, p_lat float8 default 8.4901
) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.tests (id, device_id, pu_code, nonce, captured_at, received_at, fix, acc_m, mock,
                            app_version, payload_sha256, signature, trust, status)
  values (v_id, p_device, p_pu, 'n-' || v_id, p_at, p_at + interval '1 minute',
          st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, 9, false,
          '1.0.0', digest(v_id::text, 'sha256'), 'sig', 0.8, 'accepted');
  insert into public.test_sims (test_id, sim_slot, mcc, mnc, net_type, upload_ok, total_ms)
  values (v_id, 0, 621, 30, 'LTE', p_ok, p_total_ms);
  insert into public.test_cells (test_id, sim_slot, reg, radio, mcc, mnc, area, cid, rsrp, level)
  values (v_id, 0, true, 'LTE', 621, 30, 1234, 5678901, -101, 2);
  return v_id;
end $$;

do $$
declare
  d1 uuid := '00000000-0000-0000-0000-0000000d0001';
  d2 uuid := '00000000-0000-0000-0000-0000000d0002';
  t uuid;
  r record;
begin
  -- 19:14 WAT = 18:14 UTC: an evening test.
  t := pg_temp.add_test(d1, '99-01-01-001', '2026-12-02 18:14:05+00', true, 18240);
  select * into r from public.tests where id = t;
  if not r.is_evening or r.local_date <> '2026-12-02' then
    raise exception 'FAIL: evening/local date wrong: % %', r.is_evening, r.local_date;
  end if;
  if length(r.geohash7) <> 7 or r.dist_to_pu_m is null or r.dist_to_pu_m > 50 then
    raise exception 'FAIL: geohash7/dist wrong: % %', r.geohash7, r.dist_to_pu_m;
  end if;

  -- 15:30 WAT: daytime, not a label.
  t := pg_temp.add_test(d1, '99-01-01-001', '2026-12-02 14:30:00+00', true, 9000);
  if (select is_evening from public.tests where id = t) then
    raise exception 'FAIL: daytime test marked evening';
  end if;

  -- 23:30 UTC = 00:30 WAT next day: local date rolls over, not evening.
  t := pg_temp.add_test(d1, '99-01-01-001', '2026-12-02 23:30:00+00', true, 9000);
  select * into r from public.tests where id = t;
  if r.local_date <> '2026-12-03' or r.is_evening then
    raise exception 'FAIL: WAT rollover wrong: % %', r.local_date, r.is_evening;
  end if;

  -- Daily cap: device 1 already has 2 accepted on Dec 2; the 3rd is
  -- accepted, the 4th quarantined.
  t := pg_temp.add_test(d1, '99-01-01-001', '2026-12-02 19:00:00+00', false, null);
  if (select status from public.tests where id = t) <> 'accepted' then
    raise exception 'FAIL: 3rd test of the day refused';
  end if;
  t := pg_temp.add_test(d1, '99-01-01-001', '2026-12-02 19:30:00+00', true, 5000);
  select * into r from public.tests where id = t;
  if r.status <> 'quarantined' or r.reject_reason <> 'daily_cap' then
    raise exception 'FAIL: daily cap not enforced: %', r.status;
  end if;

  -- Label: an upload over 10 minutes is a failure even if it completed.
  t := pg_temp.add_test(d2, '99-01-01-001', '2026-12-03 18:00:00+00', true, 700000);
  if (select success from public.test_sims where test_id = t) then
    raise exception 'FAIL: slow upload labelled success';
  end if;
end;
$$;

-- Evidence: unit 001 on MTN has evening tests from 2 devices on 2 evenings.
do $$
declare r record;
begin
  select * into r from public.pu_carrier_evidence where pu_code = '99-01-01-001' and mnc = 30;
  -- Evening accepted: d1 18:14 ok, d1 19:00 fail (Dec 2); d2 Dec 3 slow fail.
  if r.n_tests <> 3 or r.n_devices <> 2 or r.n_evenings <> 2 or not r.measured then
    raise exception 'FAIL: evidence wrong: %', row_to_json(r);
  end if;
  if r.w_success <> 0.8 or r.w_failure <> 1.6 then
    raise exception 'FAIL: trust weights wrong: % %', r.w_success, r.w_failure;
  end if;
end;
$$;

-- The public and dashboard users cannot read raw tests or devices.
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from public.tests limit 1;
    raise exception 'FAIL: anon can read tests';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.consume_nonce('x', gen_random_uuid());
    raise exception 'FAIL: anon can call consume_nonce';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  begin
    perform 1 from public.devices limit 1;
    raise exception 'FAIL: authenticated can read devices';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- GPS purge after 24 hours keeps distance and geohash.
-- Other tests were received in December (test dates), so they are not due.
update public.tests set received_at = now() - interval '25 hours', captured_at = now() - interval '25 hours', payload_raw = '{"fix": 1}'
where device_id = '00000000-0000-0000-0000-0000000d0002';
do $$
declare v jsonb; r record;
begin
  v := public.purge_raw_gps();
  if (v ->> 'tests')::int <> 1 then
    raise exception 'FAIL: purge count %', v;
  end if;
  select * into r from public.tests where device_id = '00000000-0000-0000-0000-0000000d0002';
  if r.fix is not null or r.payload_raw is not null or r.geohash7 is null or r.dist_to_pu_m is null then
    raise exception 'FAIL: purge removed the wrong fields';
  end if;
  if (select count(*) from public.tests where fix is null) <> 1 then
    raise exception 'FAIL: purge touched recent tests';
  end if;
end;
$$;

-- Crowd consensus: 3 independent fixes at <= 30 m set a unit's point; a
-- second vote by the same device does not count; INEC points never move.
insert into public.pu_location_votes (pu_code, device_id, geom, acc_m) values
  ('99-01-02-002', '00000000-0000-0000-0000-0000000d0001', 'SRID=4326;POINT(4.7000 8.6000)', 10),
  ('99-01-02-002', '00000000-0000-0000-0000-0000000d0001', 'SRID=4326;POINT(4.9000 8.9000)', 10),
  ('99-01-02-002', '00000000-0000-0000-0000-0000000d0002', 'SRID=4326;POINT(4.7002 8.6002)', 12),
  ('99-01-02-002', '00000000-0000-0000-0000-0000000d0003', 'SRID=4326;POINT(4.7004 8.6001)', 60);
do $$
begin
  if public.recompute_pu_location('99-01-02-002') then
    raise exception 'FAIL: consensus with only 2 independent good fixes';
  end if;
end $$;
insert into public.pu_location_votes (pu_code, device_id, geom, acc_m) values
  ('99-01-02-002', '00000000-0000-0000-0000-0000000d0003', 'SRID=4326;POINT(4.7001 8.6004)', 8);
do $$
declare r record;
begin
  -- d3's first vote (60 m) is the independent one, so still only 2 qualify.
  if public.recompute_pu_location('99-01-02-002') then
    raise exception 'FAIL: non-independent vote counted';
  end if;
  update public.pu_location_votes set acc_m = 20 where acc_m = 60;
  if not public.recompute_pu_location('99-01-02-002') then
    raise exception 'FAIL: consensus not set with 3 independent fixes';
  end if;
  select * into r from public.polling_units where pu_code = '99-01-02-002';
  if r.geom_source <> 'crowd' or st_distance(r.geom, 'SRID=4326;POINT(4.7002 8.6002)'::geography) > 30 then
    raise exception 'FAIL: consensus point wrong';
  end if;
  if public.recompute_pu_location('99-01-01-001') then
    raise exception 'FAIL: crowd overrode an INEC point';
  end if;
end;
$$;

-- Erasure removes the device and everything it contributed, and is audited.
do $$
declare n int;
begin
  n := public.erase_device_data('00000000-0000-0000-0000-0000000d0002');
  if n <> 1 then
    raise exception 'FAIL: erase returned %', n;
  end if;
  if exists (select 1 from public.tests where device_id = '00000000-0000-0000-0000-0000000d0002')
     or exists (select 1 from public.pu_location_votes where device_id = '00000000-0000-0000-0000-0000000d0002') then
    raise exception 'FAIL: erased device data remains';
  end if;
  if not exists (select 1 from public.audit_log where action = 'erase') then
    raise exception 'FAIL: erasure not audited';
  end if;
end;
$$;

-- Quarantining a device is audited.
update public.devices set status = 'quarantined', status_reason = 'mock location'
where id = '00000000-0000-0000-0000-0000000d0003';
do $$ begin
  if not exists (select 1 from public.audit_log
                 where entity = 'devices' and entity_id = '00000000-0000-0000-0000-0000000d0003') then
    raise exception 'FAIL: device status change not audited';
  end if;
end $$;
