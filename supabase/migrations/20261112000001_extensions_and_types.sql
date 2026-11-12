-- Proof of Signal: extensions and shared types.
-- Supabase installs extensions into the `extensions` schema, which is on the
-- default search_path. Security-definer functions in later migrations pin
-- their search_path explicitly.

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Where a polling unit's coordinates came from.
create type public.geom_source as enum ('inec', 'crediblevote', 'crowd');

create type public.device_status as enum ('active', 'quarantined', 'banned');

create type public.test_status as enum ('accepted', 'quarantined', 'rejected');

-- OpenCellID naming. The app maps Android's WCDMA to UMTS at ingest.
create type public.radio_type as enum ('GSM', 'UMTS', 'LTE', 'NR', 'CDMA');

create type public.irev_state as enum ('pending', 'uploaded', 'cancelled');

-- Checked in this order by the watcher (spec: Election-night watcher, step 3).
create type public.flag_class as enum (
  'HELD_SYSTEM_STALL',
  'NOT_MEASURED',
  'PLAUSIBLE_NETWORK',
  'UNEXPLAINED_DELAY',
  'WATCH'
);

-- awaiting_second: one reviewer marked concern_confirmed, the two-person rule
-- needs a second before it counts.
create type public.review_status as enum (
  'unreviewed',
  'awaiting_second',
  'concern_confirmed',
  'explained',
  'dismissed'
);

create type public.review_decision as enum ('concern_confirmed', 'explained', 'dismissed');

create type public.app_role as enum ('reviewer', 'partner', 'admin');
