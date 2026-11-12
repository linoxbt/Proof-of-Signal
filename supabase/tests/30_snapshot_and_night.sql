-- Freeze, snapshot immutability, IReV evidence, two-person review, and what
-- the public can and cannot see on election night.

insert into public.model_versions (id, feature_version, is_current) values ('test-1', 'f1', true);
insert into public.predictions (pu_code, mcc, mnc, model_version, p_model, p, p_lo, p_hi, n_tests, n_devices, n_evenings, measured)
values
  ('99-01-01-001', 621, 30, 'test-1', 0.90, 0.92, 0.85, 0.97, 3, 2, 2, true),
  ('99-01-01-001', 621, 20, 'test-1', 0.50, 0.50, 0.30, 0.70, 0, 0, 0, false),
  ('99-01-01-002', 621, 30, 'test-1', 0.30, 0.30, 0.10, 0.60, 0, 0, 0, false);

do $$
declare r record;
begin
  select * into r from public.coverage_best_carrier where pu_code = '99-01-01-001';
  -- 1 - (0.08 * 0.50) = 0.96
  if r.p_best <> 0.96 or r.n_carriers <> 2 or not r.measured then
    raise exception 'FAIL: best-carrier score wrong: %', row_to_json(r);
  end if;
end;
$$;

do $$
declare
  v_snap uuid;
begin
  v_snap := public.freeze_snapshot('replay-demo', 'test-1');
  if (select row_count from public.snapshots where id = v_snap) <> 3 then
    raise exception 'FAIL: snapshot row count';
  end if;
  if not public.snapshot_verify(v_snap) then
    raise exception 'FAIL: snapshot hash does not verify';
  end if;
  if (select snapshot_id from public.elections where id = 'replay-demo') <> v_snap then
    raise exception 'FAIL: election not linked to snapshot';
  end if;

  -- Frozen rows and the snapshot hash cannot change.
  begin
    update public.frozen_predictions set p = 0.99 where snapshot_id = v_snap;
    raise exception 'FAIL: frozen prediction updated';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.snapshots set sha256 = '\x00' where id = v_snap;
    raise exception 'FAIL: snapshot hash changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.elections set config = config || '{"p_other_flag": 0.3}' where id = 'replay-demo';
    raise exception 'FAIL: tunables changed after freeze';
  exception when insufficient_privilege then null;
  end;

  -- The timestamp token can be attached once.
  update public.snapshots set tsa_token = '\x01', tsa_at = now() where id = v_snap;
  begin
    update public.snapshots set tsa_token = '\x02' where id = v_snap;
    raise exception 'FAIL: tsa_token overwritten';
  exception when insufficient_privilege then null;
  end;

  -- Live predictions moving after the freeze do not touch the snapshot.
  update public.predictions set p = 0.10, p_lo = 0.05 where pu_code = '99-01-01-001' and mnc = 30;
  if not public.snapshot_verify(v_snap) then
    raise exception 'FAIL: snapshot changed with live predictions';
  end if;
  if public.audit_verify() is not null then
    raise exception 'FAIL: audit chain broken';
  end if;
end;
$$;

-- IReV first-seen time is recorded once.
insert into public.irev_status (election_id, pu_code, state) values
  ('replay-demo', '99-01-01-001', 'pending'),
  ('replay-demo', '99-01-01-002', 'pending'),
  ('replay-demo', '99-01-01-003', 'pending');
update public.irev_status set state = 'uploaded', first_seen_at = '2026-12-12 15:10:00+00'
where pu_code = '99-01-01-002';
do $$ begin
  begin
    update public.irev_status set first_seen_at = '2026-12-12 18:00:00+00' where pu_code = '99-01-01-002';
    raise exception 'FAIL: first_seen_at moved';
  exception when insufficient_privilege then null;
  end;
end $$;

insert into public.flags (election_id, pu_code, snapshot_id, class, p_network, p_other, evidence)
select 'replay-demo', '99-01-01-001', snapshot_id, 'UNEXPLAINED_DELAY', 0.02, 0.82, '{"n_tests": 3}'
from public.elections where id = 'replay-demo';
insert into public.flags (election_id, pu_code, snapshot_id, class, p_network, p_other, evidence)
select 'replay-demo', '99-01-01-003', snapshot_id, 'PLAUSIBLE_NETWORK', 0.97, 0.01, '{"n_tests": 0}'
from public.elections where id = 'replay-demo';

-- Public: sees buckets and counts, never the UNEXPLAINED class or p_other.
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from public.flags limit 1;
    raise exception 'FAIL: anon can read flags';
  exception when insufficient_privilege then null;
  end;
  if (select bucket from public.public_unit_status where pu_code = '99-01-01-001') <> 'needs_review' then
    raise exception 'FAIL: UNEXPLAINED_DELAY leaked to the public view';
  end if;
  if (select bucket from public.public_unit_status where pu_code = '99-01-01-003') <> 'network_failure_plausible' then
    raise exception 'FAIL: plausible bucket wrong';
  end if;
  if (select uploaded from public.night_summary where election_id = 'replay-demo') <> 1
     or (select pending from public.night_summary where election_id = 'replay-demo') <> 2 then
    raise exception 'FAIL: night summary counts';
  end if;
end $$;
rollback;

-- An authenticated non-reviewer sees no flags.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
do $$ begin
  if (select count(*) from public.flags) <> 0 then
    raise exception 'FAIL: non-reviewer sees flags';
  end if;
end $$;
rollback;

-- Two-person rule.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b001', true);
do $$
declare v_flag uuid;
begin
  select id into v_flag from public.flags where pu_code = '99-01-01-001';
  if v_flag is null then
    raise exception 'FAIL: reviewer cannot see flags';
  end if;
  insert into public.flag_reviews (flag_id, decision, note) values (v_flag, 'concern_confirmed', 'first');
  if (select review_status from public.flags where id = v_flag) <> 'awaiting_second' then
    raise exception 'FAIL: one reviewer confirmed a concern alone';
  end if;
  -- Cannot review as someone else.
  begin
    insert into public.flag_reviews (flag_id, reviewer_id, decision)
    values (v_flag, '00000000-0000-0000-0000-00000000b002', 'concern_confirmed');
    raise exception 'FAIL: reviewer impersonated another';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b002', true);
do $$
declare v_flag uuid;
begin
  select id into v_flag from public.flags where pu_code = '99-01-01-001';
  insert into public.flag_reviews (flag_id, decision, note) values (v_flag, 'concern_confirmed', 'second');
  if (select review_status from public.flags where id = v_flag) <> 'concern_confirmed' then
    raise exception 'FAIL: second confirmation not applied';
  end if;
  -- "explained" needs a reason.
  begin
    insert into public.flag_reviews (flag_id, decision)
    select id, 'explained' from public.flags where pu_code = '99-01-01-003';
    raise exception 'FAIL: explained without a reason';
  exception when check_violation then null;
  end;
end $$;
commit;

do $$ begin
  if (select review_outcome from public.public_unit_status where pu_code = '99-01-01-001') <> 'concern_raised' then
    raise exception 'FAIL: public outcome after review';
  end if;
  if (select count(*) from public.audit_log where entity = 'flag_reviews') <> 2 then
    raise exception 'FAIL: reviews not audited';
  end if;
  if public.audit_verify() is not null then
    raise exception 'FAIL: audit chain broken';
  end if;
end $$;
