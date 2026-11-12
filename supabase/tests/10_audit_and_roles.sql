-- Audit chain integrity, append-only enforcement, reviewer accreditation.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'admin@example.test'),
  ('00000000-0000-0000-0000-00000000b001', 'reviewer1@example.test'),
  ('00000000-0000-0000-0000-00000000b002', 'reviewer2@example.test'),
  ('00000000-0000-0000-0000-00000000c001', 'outsider@example.test');

insert into public.user_roles (user_id, role, org_id)
select '00000000-0000-0000-0000-00000000a001', 'admin', id from public.organisations where kind = 'team';
insert into public.user_roles (user_id, role, org_id)
select u, 'reviewer', o.id
from public.organisations o,
     unnest(array['00000000-0000-0000-0000-00000000b001',
                  '00000000-0000-0000-0000-00000000b002']::uuid[]) u
where o.name = 'Demo Observer Group (synthetic)';

do $$
begin
  -- A reviewer from a non-accredited organisation is refused.
  begin
    insert into public.user_roles (user_id, role, org_id)
    select '00000000-0000-0000-0000-00000000c001', 'reviewer', id
    from public.organisations where kind = 'team';
    raise exception 'FAIL: reviewer accepted from a non-accredited organisation';
  exception when check_violation then null;
  end;

  -- Role grants were audited and the chain verifies.
  if (select count(*) from public.audit_log where entity = 'user_roles') < 3 then
    raise exception 'FAIL: role grants not audited';
  end if;
  if public.audit_verify() is not null then
    raise exception 'FAIL: audit chain broken at %', public.audit_verify();
  end if;

  -- Rows cannot be edited or deleted.
  begin
    update public.audit_log set action = 'tampered' where id = 1;
    raise exception 'FAIL: audit_log update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.audit_log where id = 1;
    raise exception 'FAIL: audit_log delete allowed';
  exception when insufficient_privilege then null;
  end;

  -- Sealing a day returns the tail hash.
  if public.seal_audit_day((now() at time zone 'UTC')::date)
     is distinct from (select row_hash from public.audit_log order by id desc limit 1) then
    raise exception 'FAIL: daily root is not the chain tail';
  end if;
end;
$$;

-- Tampering bypassing the trigger (as a superuser could) is detected.
begin;
alter table public.audit_log disable trigger audit_log_no_update;
update public.audit_log set detail = '{"tampered": true}' where id = 2;
do $$ begin
  if public.audit_verify() is distinct from 2 then
    raise exception 'FAIL: tampering not detected';
  end if;
end $$;
rollback;

-- Outsiders and the public cannot read the audit log.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
do $$ begin
  if (select count(*) from public.audit_log) <> 0 then
    raise exception 'FAIL: non-admin can read audit_log';
  end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a001', true);
do $$ begin
  if (select count(*) from public.audit_log) = 0 then
    raise exception 'FAIL: admin cannot read audit_log';
  end if;
end $$;
rollback;
