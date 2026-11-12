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

-- Supabase reads the JWT subject from request.jwt.claim(s); tests set it with
-- set_config('request.jwt.claim.sub', ...).
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

do $$ begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
set search_path = "$user", public, extensions;
