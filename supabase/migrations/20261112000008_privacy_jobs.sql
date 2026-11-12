-- Data minimisation jobs and function grants.

-- Raw GPS is kept 24 hours for validation (place check, teleport check),
-- then only dist_to_pu_m and the 7-character geohash remain.
create or replace function public.purge_raw_gps(p_older_than interval default interval '24 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tests int;
  v_votes int;
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

  delete from public.nonces where expires_at < now() - interval '1 day';
  get diagnostics v_nonces = row_count;

  return jsonb_build_object('tests', v_tests, 'votes', v_votes, 'nonces', v_nonces);
end;
$$;

-- Internal functions are for the service role and pg_cron only.
revoke execute on function public.purge_raw_gps(interval) from public, anon, authenticated;
revoke execute on function public.seal_audit_day(date) from public, anon, authenticated;
revoke execute on function public.recompute_pu_location(text) from public, anon, authenticated;
revoke execute on function public.freeze_snapshot(text, text) from public, anon, authenticated;
revoke execute on function public.audit_verify() from public, anon, authenticated;

-- Schedules. pg_cron is available on Supabase; local test databases without
-- it skip this block.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('purge-raw-gps', '17 * * * *', $$select public.purge_raw_gps()$$);
    perform cron.schedule('seal-audit-day', '5 0 * * *',
      $$select public.seal_audit_day(((now() at time zone 'UTC') - interval '1 day')::date)$$);
  else
    raise notice 'pg_cron not available: schedules not created';
  end if;
end;
$do$;
