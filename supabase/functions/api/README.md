# `api` Edge Function

Serves every `/v1/*` endpoint in `contracts/api.md` except the probe (`services/probe`) and the watcher control endpoints. It's one function with a small router. Everything up to and including the `/api` path segment is stripped, so `https://<ref>.supabase.co/functions/v1/api/v1/tests` routes as `/v1/tests`.

| Path | What |
| --- | --- |
| `index.ts` | Entry point (`Deno.serve`) |
| `app.ts` | Builds the handler from a config, a Postgres pool and an integrity verifier |
| `lib/router.ts` | Routes, prefix stripping, error shape, CORS |
| `lib/jcs.ts` | RFC 8785 canonical JSON |
| `lib/crypto.ts` | Base64, SHA-256, strict DER to raw `r‖s`, ES256 verification from SPKI |
| `lib/schema.ts` | Ajv (draft 2020-12) validation against `schema/test-payload.schema.json`, a copy of the contract schema that a test keeps identical; also the rules the schema can't express (unique SIM slots, offline runs cannot claim `ok`) and the WCDMA to UMTS mapping |
| `lib/checks.ts` | Ingest checks table and trust, as pure functions |
| `lib/integrity.ts` | Play Integrity: Google `decodeIntegrityToken` with a service-account JWT, or `off` |
| `lib/jwt.ts` | HS256 verification of Supabase access tokens; RS256 signing for the Google assertion |
| `lib/db.ts` | `npm:postgres` pool; `asUser` (reviewer: `set local role authenticated` plus JWT claims) and `asAnon` (public night endpoints) |
| `handlers/*` | Endpoint handlers |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPABASE_DB_URL` (or `DATABASE_URL`) | required | Postgres URL for a role that bypasses RLS. Supabase sets it automatically. |
| `SUPABASE_JWT_SECRET` | none | HS256 secret for reviewer bearer tokens. Without it, reviewer endpoints return 401. |
| `DASHBOARD_ORIGIN` | empty | CORS origin for non-GET requests |
| `PLAY_INTEGRITY_MODE` | `google` | `google` or `off` |
| `PLAY_PACKAGE_NAME` | none | App package. Required for `google`; checked against `requestPackageName`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | none | Service-account key JSON (raw or base64). Required for `google`. |
| `ALLOW_UNVERIFIED_DEVICES` | `false` | With `off`, `true` lets `UNVERIFIED` devices be `active`. Otherwise they are quarantined. |
| `PLACE_RADIUS_M` | `150` | Place check radius |
| `RATE_DEVICE_NONCE_PER_HOUR` | `30` | Nonces per device per hour. Exact: counted from `nonces` under a row lock. |
| `RATE_IP_DEVICES_PER_HOUR`, `RATE_IP_NONCE_PER_HOUR`, `RATE_IP_TESTS_PER_HOUR` | `20`, `300`, `300` | Per-IP limits. In memory, per isolate, best effort. |
| `DB_POOL_MAX` | `5` | Connections per isolate |

The client IP is taken from `cf-connecting-ip`, then `x-forwarded-for`.

Devices carry no Supabase JWT, so deploy with JWT verification off at the gateway: `supabase functions deploy api --no-verify-jwt`, or set `[functions.api] verify_jwt = false` in `supabase/config.toml`. Reviewer endpoints verify their own token.

## Behaviour notes

These are choices where the contract is silent:

- **Integrity outages.** If Google's API is unreachable or returns 5xx, the request fails with `500 internal` and nothing is quarantined. Google `400` (an invalid token) is treated as a failed verdict.
- **Duplicates.** A duplicate is matched on `payload_sha256`. For offline runs (`nonce: null`) only, the same device, unit and `ts` also counts as a duplicate, because an ECDSA signature can be re-encoded (`s → n − s`) without the key.
- **Teleport check.** It uses the device's nearest-in-time test within ±24 h that still has a raw fix and was neither rejected nor mock. Both fixes' accuracy radii are subtracted from the distance, and the time gap is floored at 1 s.
- **Clock.** The clock check compares `ts` with the server's receive time. When `ts` is more than 10 minutes in the future, `captured_at` is stored capped at receive time + 10 min, to satisfy the table check. The original `ts` stays in `payload_raw`, and such a test is always rejected or quarantined.
- **Crowd location.** Only accepted tests cast location votes.
- **Daily cap.** A test the daily-cap trigger quarantines gets `trust = 0`.
- **Progress.** `/v1/map/progress` counts `tested` and `measured` with the same all-carrier rule as `progress`.
- **Night units.** `/v1/night/{election}/units` leaves out cancelled units, because `bucket` has no cancelled value. A unit with no `irev_status` row is pending.
- **Second review.** A second review by the same reviewer returns `409` with code `already_reviewed`.
- **Errors.** Unknown routes and methods return `404 not_found`. Unknown devices and polling units also return `404 not_found`. Bodies over 256 KiB return `400 invalid_body`.

## Tests

You need Deno 2 (`npm i -g deno`) and the local database (`scripts/db-dev.sh`).

```sh
PGDEV_PORT=54331 scripts/db-dev.sh start            # from the repo root
cd supabase/functions/api
deno task test:unit                                  # JCS, DER, ES256, checks, schema, integrity, JWT, CORS
DATABASE_URL=postgresql://postgres@127.0.0.1:54331/pos_dev deno task test:integration
deno task test                                       # both
deno task check && deno task lint
```

The integration test runs the real router against the database: devices, nonces, every ingest outcome, crowd location, erasure, the public reads, the night endpoints, and the reviewer flow with HS256 tokens it signs itself. It uses units in state code 98, cleans its own rows first, and can be re-run. Play Integrity is replaced by a fixture verifier that accepts `pass:<expected request hash>`, so the request-hash binding is tested end to end. The Google client is unit-tested against a fake `fetch` that verifies the service-account assertion signature.

To run locally against the dev database:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:54331/pos_dev PLAY_INTEGRITY_MODE=off ALLOW_UNVERIFIED_DEVICES=true \
  SUPABASE_JWT_SECRET=dev-secret deno task serve
```
