-- Reference data: polling units, carriers, cell towers, crowd location votes.
-- All of it is public data or derived from consented volunteer fixes.

-- PU codes are State-LGA-Ward-Unit, zero-padded by the importer, e.g. 28-07-05-012.
create table public.polling_units (
  pu_code        text primary key check (pu_code ~ '^\d{2}-\d{2}-\d{2}-\d{3}$'),
  state_code     smallint generated always as (split_part(pu_code, '-', 1)::smallint) stored,
  lga_code       smallint generated always as (split_part(pu_code, '-', 2)::smallint) stored,
  ward_code      smallint generated always as (split_part(pu_code, '-', 3)::smallint) stored,
  state          text not null,
  lga            text not null,
  ward           text not null,
  name           text not null,
  location_desc  text,
  geom           extensions.geography(Point, 4326),
  geom_source    public.geom_source,
  -- 0 to 1. For crowd points, rises with the number of independent fixes.
  geom_conf      numeric(4, 3) check (geom_conf between 0 and 1),
  updated_at     timestamptz not null default now(),
  check ((geom is null) = (geom_source is null))
);

create index polling_units_geom_idx on public.polling_units using gist (geom);
create index polling_units_admin_idx on public.polling_units (state_code, lga_code, ward_code);

-- Nigeria's MCC is 621. MNCs are from memory in the spec: `verified` stays
-- false until checked against downloaded OpenCellID rows.
create table public.carriers (
  mcc       smallint not null,
  mnc       smallint not null,
  name      text not null,
  verified  boolean not null default false,
  primary key (mcc, mnc)
);

insert into public.carriers (mcc, mnc, name) values
  (621, 30, 'MTN'),
  (621, 20, 'Airtel'),
  (621, 50, 'Glo'),
  (621, 60, '9mobile');

-- Tower table: OpenCellID (CC BY-SA 4.0, attribute and share alike) merged
-- with cells our volunteers observed.
create table public.cells (
  radio         public.radio_type not null,
  mcc           smallint not null,
  mnc           smallint not null,
  area          integer not null,  -- TAC for LTE/NR, LAC for GSM/UMTS
  cid           bigint not null,
  geom          extensions.geography(Point, 4326),
  range_m       integer,
  ocid_samples  integer not null default 0,
  our_samples   integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (radio, mcc, mnc, area, cid)
);

create index cells_geom_idx on public.cells using gist (geom);

-- Location votes: a volunteer fix at a unit that has no INEC or CredibleVoteNG
-- point yet. device_id is cleared after 24 hours with the rest of the raw GPS;
-- `independent` records at insert time whether this was the device's first
-- vote for the unit, so the consensus rule still counts distinct devices.
create table public.pu_location_votes (
  id           bigint generated always as identity primary key,
  pu_code      text not null references public.polling_units (pu_code) on delete cascade,
  device_id    uuid,  -- FK added with devices; null after 24 h
  test_id      uuid,  -- FK added with tests
  geom         extensions.geography(Point, 4326) not null,
  acc_m        real not null check (acc_m > 0),
  independent  boolean not null default true,
  created_at   timestamptz not null default now()
);

create index pu_location_votes_pu_idx on public.pu_location_votes (pu_code);

create or replace function public.mark_vote_independence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.independent := new.device_id is not null and not exists (
    select 1 from public.pu_location_votes v
    where v.pu_code = new.pu_code and v.device_id = new.device_id
  );
  return new;
end;
$$;

create trigger pu_location_votes_independence
  before insert on public.pu_location_votes
  for each row execute function public.mark_vote_independence();

-- Consensus point: median of 3 or more independent fixes at 30 m accuracy or
-- better. Never overrides an INEC or CredibleVoteNG point. Returns true when
-- the unit's point was set or moved.
create or replace function public.recompute_pu_location(p_pu_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
  v_lng double precision;
  v_lat double precision;
begin
  if exists (
    select 1 from public.polling_units
    where pu_code = p_pu_code and geom_source in ('inec', 'crediblevote')
  ) then
    return false;
  end if;

  select count(*),
         percentile_cont(0.5) within group (order by extensions.st_x(geom::extensions.geometry)),
         percentile_cont(0.5) within group (order by extensions.st_y(geom::extensions.geometry))
    into v_n, v_lng, v_lat
  from public.pu_location_votes
  where pu_code = p_pu_code and independent and acc_m <= 30;

  if v_n < 3 then
    return false;
  end if;

  update public.polling_units
     set geom = extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography,
         geom_source = 'crowd',
         geom_conf = least(1, v_n / 10.0),
         updated_at = now()
   where pu_code = p_pu_code;
  return true;
end;
$$;

alter table public.polling_units enable row level security;
alter table public.carriers enable row level security;
alter table public.cells enable row level security;
alter table public.pu_location_votes enable row level security;

-- The PU list, carriers and towers are public data.
create policy polling_units_read on public.polling_units
  for select to anon, authenticated using (true);
create policy carriers_read on public.carriers
  for select to anon, authenticated using (true);
create policy cells_read on public.cells
  for select to anon, authenticated using (true);
-- pu_location_votes: no policies, service role only.

revoke insert, update, delete, truncate on public.polling_units, public.carriers,
  public.cells, public.pu_location_votes from anon, authenticated;
revoke select on public.pu_location_votes from anon, authenticated;
