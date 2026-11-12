# Proof of Signal

Proof of Signal is a pre-election census of mobile upload capability at Nigerian polling units. It measures upload capability at units volunteers visit and predicts it for the rest. On election night it says whether a missing IReV upload is explained by the network, by INEC's servers, or by neither. It never shows vote figures. Build spec: https://claude.ai/artifact/DJs2exvavHeMmZ5zd7JcV1

## Layout

| Path | What | Status |
| --- | --- | --- |
| `supabase/` | Postgres + PostGIS schema, RLS, seed, tests; Edge Functions | Schema done; functions planned |
| `apps/sweep` | Android sweep app (Expo + Kotlin `pos-radio`) | Planned |
| `apps/dashboard` | Excuse Meter and Risk Register (Next.js) | Planned |
| `services/probe` | Upload probe | Planned |
| `services/model` | Coverage model and freeze | Planned |
| `services/watcher` | Election-night watcher and replay | Planned |
| `data/` | Download scripts only, never raw data | Planned |
| `docs/` | Model card, DPIA, method | Planned |

## Database

Migrations in `supabase/migrations`, in order:

1. Extensions (PostGIS, pgcrypto) and enums.
2. Organisations and dashboard roles. A reviewer must belong to an accredited organisation (`has_role()`).
3. A hash-chained, append-only `audit_log` (`audit_verify()`), plus daily roots (`seal_audit_day()`) for RFC 3161 stamping.
4. Reference data: `polling_units`, `carriers` (MNCs unverified), `cells`, and crowd location votes with a median consensus (`recompute_pu_location()`).
5. Devices, single-use nonces (`consume_nonce()`), and signed `tests` with per-SIM `test_sims` and `test_cells`. The label is a 1.5 MB upload within 10 minutes, taken between 17:00 and 23:59 WAT. Tests over 3 per device per unit per day are quarantined. The `pu_carrier_evidence` view applies the "measured" rule. `erase_device_data()` erases a volunteer's data.
6. Model versions, features and `predictions`, plus the `coverage_current` and `coverage_best_carrier` views. Elections hold their tunables. `freeze_snapshot()` writes immutable `frozen_predictions` with a sha256 (`snapshot_verify()`). The tunables are locked after the freeze.
7. Election night tables: `irev_status` (first-seen time, set once), `stall_events`, `flags`, and `flag_reviews`, which enforce a two-person rule for `concern_confirmed`. Public views are `public_unit_status`, which never exposes `UNEXPLAINED_DELAY`, and `night_summary`.
8. `purge_raw_gps()` drops raw GPS after 24 h. pg_cron schedules run when the extension is available.

The tables that hold raw tests, devices, nonces, features and location votes have RLS on and no client policies. Only the service role (Edge Functions, Python services) touches them.

### Testing locally

```sh
scripts/db-test.sh   # needs postgresql-16 + postgresql-16-postgis-3
```

The script applies every migration to a throwaway Postgres on top of a small Supabase stub (`supabase/tests/00_supabase_stub.sql`). It then loads the synthetic seed (state code 99, which doesn't exist) and runs `supabase/tests/*.sql`. CI runs the same script (`.github/workflows/db.yml`).

To deploy, run `supabase link --project-ref <ref>` and then `supabase db push`.
