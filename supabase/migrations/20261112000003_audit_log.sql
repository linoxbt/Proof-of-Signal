-- Append-only, hash-chained audit log (spec: Security, "Backdating evidence").
-- row_hash = sha256(prev_hash || canonical row text). Each day's last row_hash
-- is sealed into audit_roots and timestamped through an RFC 3161 authority
-- by a separate service, so any later edit to the chain is detectable.

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default clock_timestamp(),
  actor      uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb,
  prev_hash  bytea not null,
  row_hash   bytea not null unique
);

create index audit_log_entity_idx on public.audit_log (entity, entity_id);
create index audit_log_at_idx on public.audit_log (at);

create or replace function public.audit_row_text(
  p_id bigint, p_at timestamptz, p_actor uuid, p_action text,
  p_entity text, p_entity_id text, p_detail jsonb
)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select convert_to(concat_ws('|',
    p_id::text,
    to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_actor::text, ''),
    p_action,
    p_entity,
    coalesce(p_entity_id, ''),
    p_detail::text
  ), 'UTF8');
$$;

create or replace function public.audit_chain()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prev bytea;
begin
  -- Serialise writers so the chain has exactly one tail.
  perform pg_advisory_xact_lock(hashtext('public.audit_log'));
  select row_hash into v_prev from public.audit_log order by id desc limit 1;
  new.prev_hash := coalesce(v_prev, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  new.row_hash := extensions.digest(
    new.prev_hash || public.audit_row_text(new.id, new.at, new.actor, new.action,
                                           new.entity, new.entity_id, new.detail),
    'sha256');
  return new;
end;
$$;

create trigger audit_log_chain
  before insert on public.audit_log
  for each row execute function public.audit_chain();

create or replace function public.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.forbid_change();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.forbid_change();

-- Returns the id of the first row whose hash does not verify, or null when
-- the whole chain is intact.
create or replace function public.audit_verify()
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  r record;
  v_prev bytea := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
begin
  for r in select * from public.audit_log order by id loop
    if r.prev_hash <> v_prev
       or r.row_hash <> extensions.digest(
            v_prev || public.audit_row_text(r.id, r.at, r.actor, r.action,
                                            r.entity, r.entity_id, r.detail),
            'sha256') then
      return r.id;
    end if;
    v_prev := r.row_hash;
  end loop;
  return null;
end;
$$;

-- Generic row logger. TG_ARGV[0] names the key column used as entity_id.
create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_row ->> tg_argv[0],
    case tg_op
      when 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      else jsonb_build_object('row', v_row)
    end
  );
  return null;
end;
$$;

-- Daily roots. tsa_token is filled in by the integrity service after it
-- stamps root_hash with an RFC 3161 authority (for example FreeTSA).
create table public.audit_roots (
  day        date primary key,
  last_id    bigint not null references public.audit_log (id),
  root_hash  bytea not null,
  sealed_at  timestamptz not null default now(),
  tsa_token  bytea,
  tsa_at     timestamptz
);

-- Seals a UTC day: its root is the row_hash of the day's last row, which by
-- construction commits to every row before it.
create or replace function public.seal_audit_day(p_day date)
returns bytea
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_hash bytea;
begin
  select id, row_hash into v_id, v_hash
  from public.audit_log
  where at < ((p_day + 1)::timestamp at time zone 'UTC')
  order by id desc
  limit 1;

  if v_id is null then
    return null;
  end if;

  insert into public.audit_roots (day, last_id, root_hash)
  values (p_day, v_id, v_hash)
  on conflict (day) do nothing;

  return v_hash;
end;
$$;

alter table public.audit_log enable row level security;
alter table public.audit_roots enable row level security;

revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;
revoke insert, update, delete, truncate on public.audit_roots from anon, authenticated;

create policy audit_log_admin_read on public.audit_log
  for select to authenticated using (public.has_role('admin'));
-- Roots are public: anyone can check a published root against its timestamp.
create policy audit_roots_read on public.audit_roots
  for select to anon, authenticated using (true);

-- Role changes are audited.
create trigger user_roles_audit
  after insert or update or delete on public.user_roles
  for each row execute function public.audit_row('user_id');
create trigger organisations_audit
  after insert or update or delete on public.organisations
  for each row execute function public.audit_row('id');
