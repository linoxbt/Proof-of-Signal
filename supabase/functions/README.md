# Edge Functions (Deno, TypeScript)

| Function | Serves | Notes |
| --- | --- | --- |
| [`api`](api/README.md) | Every `/v1/*` endpoint in `contracts/api.md` except the probe and the watcher control endpoints | Device endpoints, public reads, reviewer endpoints |

The function connects to Postgres directly with `SUPABASE_DB_URL` (`npm:postgres`).

- Device endpoints and public reads run as the connection role, which bypasses RLS. The tables they write (`devices`, `nonces`, `tests`, `test_sims`, `test_cells`, `pu_location_votes`) have RLS on and no anon or authenticated policies.
- Public night endpoints run as `anon`, so they read only `public_unit_status` and other public tables.
- Reviewer endpoints verify the Supabase access token (HS256) and run as `authenticated` with the JWT claims set, so RLS and `has_role()` decide access.

Deploy with `supabase functions deploy api --no-verify-jwt`, because devices carry no Supabase JWT. Environment variables and tests are documented in [`api/README.md`](api/README.md).
