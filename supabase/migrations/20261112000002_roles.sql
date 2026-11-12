-- Organisations and dashboard roles.
-- Volunteers never sign in: the sweep app authenticates with a device key and
-- talks only to Edge Functions (service role). These roles are for the
-- dashboard: accredited reviewers, partners (INEC, telcos, CSOs) and admins.

create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  kind        text not null check (kind in ('observer', 'inec', 'telco', 'regulator', 'media', 'team')),
  -- Reviewer accounts are allowed only from accredited partner organisations.
  accredited  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.user_roles (
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.app_role not null,
  org_id      uuid not null references public.organisations (id),
  granted_by  uuid references auth.users (id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, role)
);

create index user_roles_org_idx on public.user_roles (org_id);

-- True when the signed-in user holds role `r`. A reviewer role only counts
-- while its organisation is accredited, so revoking accreditation revokes
-- every reviewer in it at once.
create or replace function public.has_role(r public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.organisations o on o.id = ur.org_id
    where ur.user_id = auth.uid()
      and ur.role = r
      and (r <> 'reviewer' or o.accredited)
  );
$$;

create or replace function public.check_reviewer_org()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'reviewer' and not exists (
    select 1 from public.organisations o where o.id = new.org_id and o.accredited
  ) then
    raise exception 'reviewer role requires an accredited organisation'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger user_roles_reviewer_org
  before insert or update on public.user_roles
  for each row execute function public.check_reviewer_org();

alter table public.organisations enable row level security;
alter table public.user_roles enable row level security;

create policy organisations_read on public.organisations
  for select to authenticated using (true);
create policy organisations_admin on public.organisations
  for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy user_roles_read_own on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin'));
create policy user_roles_admin on public.user_roles
  for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
