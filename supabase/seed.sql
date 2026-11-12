-- Synthetic seed for local development and the replay demo.
-- State code 99 does not exist (Nigeria's codes run 01 to 37), so these units
-- can never be mistaken for real ones. No real PU, voter or vote data here.

insert into public.organisations (name, kind, accredited) values
  ('Proof of Signal team', 'team', false),
  ('Demo Observer Group (synthetic)', 'observer', true)
on conflict (name) do nothing;

insert into public.polling_units (pu_code, state, lga, ward, name, geom, geom_source, geom_conf) values
  ('99-01-01-001', 'Demo State', 'Demo North', 'Ward A', 'Demo Primary School I',
   'SRID=4326;POINT(4.5500 8.4900)', 'inec', 1),
  ('99-01-01-002', 'Demo State', 'Demo North', 'Ward A', 'Demo Market Square',
   'SRID=4326;POINT(4.5560 8.4930)', 'inec', 1),
  ('99-01-01-003', 'Demo State', 'Demo North', 'Ward A', 'Demo Town Hall',
   'SRID=4326;POINT(4.5610 8.4870)', 'crediblevote', 0.8),
  ('99-01-02-001', 'Demo State', 'Demo North', 'Ward B', 'Demo Health Centre',
   'SRID=4326;POINT(4.6200 8.5400)', 'inec', 1),
  ('99-01-02-002', 'Demo State', 'Demo North', 'Ward B', 'Demo Village Square', null, null, null)
on conflict (pu_code) do nothing;

insert into public.elections (id, name, election_date, state_codes, polls_close_at, is_replay) values
  ('replay-demo', 'Synthetic replay (demo)', '2026-12-12', '{99}', '2026-12-12 14:30:00+00', true)
on conflict (id) do nothing;
