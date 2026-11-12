-- Minimal stand-in for what a Supabase project provides, so migrations can be
-- applied and tested on a plain Postgres + PostGIS. Never applied to Supabase.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create schema extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role;

create table auth.users (
  id     uuid primary key,
  email  text
);

-- Same shape as Supabase's auth.uid(): the legacy per-claim setting, else the
-- `sub` of request.jwt.claims.
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

do $$ begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
set search_path = "$user", public, extensions;
