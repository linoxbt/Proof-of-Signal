-- Election night: IReV upload status, system stalls, flags and reviews.
-- The watcher stores only when each unit's result first appears on IReV,
-- never the sheet contents and never any vote figure.

create table public.irev_status (
  election_id    text not null references public.elections (id),
  pu_code        text not null references public.polling_units (pu_code),
  state          public.irev_state not null default 'pending',
  first_seen_at  timestamptz,  -- first time the unit showed as uploaded
  fetched_at     timestamptz not null default now(),
  page_hash      text,
  primary key (election_id, pu_code),
  check ((state = 'uploaded') = (first_seen_at is not null) or state = 'cancelled')
);

create index irev_status_state_idx on public.irev_status (election_id, state);

-- first_seen_at is evidence: once set it never moves.
create or replace function public.irev_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.first_seen_at is not null and new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'first_seen_at for % is already recorded', old.pu_code
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger irev_status_first_seen
  before update on public.irev_status
  for each row execute function public.irev_status_guard();

create table public.stall_events (
  id           bigint generated always as identity primary key,
  election_id  text not null references public.elections (id),
  started_at   timestamptz not null,
  ended_at     timestamptz,
  -- Stratum rates, ratio difference, pending share at detection.
  evidence     jsonb not null default '{}'::jsonb,
  check (ended_at is null or ended_at >= started_at)
);

create unique index stall_events_one_open on public.stall_events (election_id) where ended_at is null;

create table public.flags (
  id             uuid primary key default gen_random_uuid(),
  election_id    text not null references public.elections (id),
  pu_code        text not null references public.polling_units (pu_code),
  snapshot_id    uuid not null references public.snapshots (id),
  class          public.flag_class not null,
  p_network      numeric(5, 4) check (p_network between 0 and 1),
  p_other        numeric(5, 4) check (p_other between 0 and 1),
  -- The evidence card: tests, devices, carriers, evenings, per-carrier score
  -- and interval, neighbours uploaded with times, S(t), snapshot hash, caveat.
  evidence       jsonb not null,
  review_status  public.review_status not null default 'unreviewed',
  reviewer_id    uuid references auth.users (id),
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (election_id, pu_code)
);

create index flags_queue_idx on public.flags (election_id, class, review_status, created_at);

create table public.flag_reviews (
  id           bigint generated always as identity primary key,
  flag_id      uuid not null references public.flags (id),
  reviewer_id  uuid not null default auth.uid() references auth.users (id),
  decision     public.review_decision not null,
  note         text,
  created_at   timestamptz not null default now(),
  unique (flag_id, reviewer_id),
  check (decision <> 'explained' or coalesce(length(trim(note)), 0) > 0)
);

create trigger flag_reviews_no_update
  before update or delete on public.flag_reviews
  for each row execute function public.forbid_change();

-- Applies a review to its flag. concern_confirmed needs two different
-- reviewers (two-person rule); explained and dismissed take one.
create or replace function public.apply_flag_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirms int;
  v_status public.review_status;
begin
  if new.decision = 'concern_confirmed' then
    select count(distinct reviewer_id) into v_confirms
    from public.flag_reviews
    where flag_id = new.flag_id and decision = 'concern_confirmed';
    v_status := case when v_confirms >= 2 then 'concern_confirmed' else 'awaiting_second' end;
  else
    v_status := new.decision::text::public.review_status;
  end if;

  update public.flags
     set review_status = v_status,
         reviewer_id = new.reviewer_id,
         note = coalesce(new.note, note),
         updated_at = now()
   where id = new.flag_id;
  return null;
end;
$$;

create trigger flag_reviews_apply
  after insert on public.flag_reviews
  for each row execute function public.apply_flag_review();

create trigger flag_reviews_audit
  after insert on public.flag_reviews
  for each row execute function public.audit_row('flag_id');
create trigger flags_audit
  after insert or update of class, review_status on public.flags
  for each row execute function public.audit_row('id');

-- Public status per unit. UNEXPLAINED_DELAY and WATCH both read
-- "needs review" until a review is complete, and the public only ever sees
-- the outcome as explained or concern raised for follow-up.
create view public.public_unit_status as
select
  f.election_id,
  f.pu_code,
  case f.class
    when 'HELD_SYSTEM_STALL' then 'held_system_stall'
    when 'NOT_MEASURED' then 'not_enough_tests'
    when 'PLAUSIBLE_NETWORK' then 'network_failure_plausible'
    else 'needs_review'
  end as bucket,
  case f.review_status
    when 'explained' then 'explained'
    when 'concern_confirmed' then 'concern_raised'
  end as review_outcome,
  f.updated_at
from public.flags f;

-- GET /v1/night/{election}/summary: upload progress per state and the stall
-- banner state. Counts only, never results.
create view public.night_summary as
select
  i.election_id,
  pu.state_code,
  min(pu.state) as state,
  count(*)                                        as units,
  count(*) filter (where i.state = 'uploaded')    as uploaded,
  count(*) filter (where i.state = 'pending')     as pending,
  count(*) filter (where i.state = 'cancelled')   as cancelled,
  exists (select 1 from public.stall_events s
          where s.election_id = i.election_id and s.ended_at is null) as system_stall
from public.irev_status i
join public.polling_units pu on pu.pu_code = i.pu_code
group by i.election_id, pu.state_code;

alter table public.irev_status enable row level security;
alter table public.stall_events enable row level security;
alter table public.flags enable row level security;
alter table public.flag_reviews enable row level security;

create policy irev_status_read on public.irev_status
  for select to anon, authenticated using (true);
create policy stall_events_read on public.stall_events
  for select to anon, authenticated using (true);

create policy flags_reviewer_read on public.flags
  for select to authenticated
  using (public.has_role('reviewer') or public.has_role('admin'));

create policy flag_reviews_reviewer_read on public.flag_reviews
  for select to authenticated
  using (public.has_role('reviewer') or public.has_role('admin'));
create policy flag_reviews_reviewer_insert on public.flag_reviews
  for insert to authenticated
  with check (public.has_role('reviewer') and reviewer_id = auth.uid());

revoke insert, update, delete, truncate on public.irev_status, public.stall_events, public.flags
  from anon, authenticated;
revoke all on public.flags, public.flag_reviews from anon;
revoke update, delete, truncate on public.flag_reviews from authenticated;
grant select on public.public_unit_status, public.night_summary to anon, authenticated;
