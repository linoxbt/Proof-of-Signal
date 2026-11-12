# Proof of Signal API contract (v1)

Source of truth for every component. The database schema is in `supabase/migrations`; the build spec is https://claude.ai/artifact/DJs2exvavHeMmZ5zd7JcV1.

## Hosts

| Host | Serves | Deployed as |
| --- | --- | --- |
| `API_BASE` | `/v1/*` below | One Supabase Edge Function named `api`, reached at `https://<ref>.supabase.co/functions/v1/api`; production puts `https://api.<domain>` in front through Cloudflare (proxied) |
| `PROBE_BASE` | `/v1/probe/*` | `services/probe` on Azure Container Apps. **DNS-only, never proxied or cached**, so timings measure the radio path and the probe sees the true client IP |
| watcher | `/healthz`, `/status`, `/replay/*` | `services/watcher` (internal, admin token) |

So `API_BASE + "/v1/tests"` = `https://<ref>.supabase.co/functions/v1/api/v1/tests`. The function strips everything up to and including `/api`.

All bodies are JSON (`content-type: application/json; charset=utf-8`) unless stated. Times are RFC 3339. CORS: `GET` endpoints allow any origin; others allow `DASHBOARD_ORIGIN`.

## Errors

Every non-2xx response: `{"error": {"code": "<snake_case>", "message": "<human text>"}}`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_body`, `invalid_query`, `schema_violation` |
| 401 | `bad_signature`, `unauthenticated` |
| 403 | `device_quarantined`, `device_banned`, `forbidden`, `integrity_failed` |
| 404 | `not_found`, `unknown_nonce` |
| 409 | `nonce_used` |
| 410 | `nonce_expired` |
| 429 | `rate_limited` (with `retry-after` seconds) |
| 500 | `internal` |

## Auth

- **Devices** (sweep app) never hold a user account. They prove themselves with the ES256 key registered at `POST /v1/devices`, signing each test payload. Nonce issuance is unauthenticated but rate limited per device id and IP.
- **Dashboard users** sign in with Supabase Auth (email magic link). Reviewer endpoints take `Authorization: Bearer <Supabase access token>`. The API verifies the JWT (`SUPABASE_JWT_SECRET`, HS256) and runs reviewer queries as role `authenticated` with the JWT claims set, so RLS and `has_role()` decide access:
  `set local role authenticated; select set_config('request.jwt.claims', '<claims json>', true), set_config('request.jwt.claim.sub', '<sub>', true);`
- **Services** (model, watcher, probe, the `api` function itself for device endpoints) connect to Postgres directly with `DATABASE_URL` (`SUPABASE_DB_URL` inside Edge Functions) as a role that bypasses RLS.

## Signing (device payloads)

- Key: EC P-256 in Android Keystore, `SHA256withECDSA`.
- `pubkey`: base64 (standard, padded) of the X.509 **SubjectPublicKeyInfo DER** (`publicKey.encoded` on Android). WebCrypto: `importKey("spki", ...)`.
- Signed bytes: UTF-8 of the **RFC 8785 (JCS) canonical JSON** of the payload object with the `sig` member removed.
- `sig`: base64 (standard, padded) of the **DER** ECDSA signature exactly as Android's `Signature.sign()` returns it. The server converts DER to raw `r||s` (64 bytes) before WebCrypto `verify`.
- `payload_sha256` stored in `tests` = SHA-256 of the same canonical bytes plus `sig` (i.e. canonical JSON of the full payload).

## Device endpoints

### `POST /v1/devices`

Request:
```json
{"pubkey": "<base64 SPKI DER>", "integrity_token": "<Play Integrity standard token>", "app_version": "1.0.0"}
```
The integrity request hash is `base64url(sha256(pubkey DER bytes))`, binding the token to the key.

Server: verifies the token (`PLAY_INTEGRITY_MODE=google`: Google `decodeIntegrityToken` with a service account; `=off`: skip, `integrity_level = 'UNVERIFIED'`, allowed only when `ALLOW_UNVERIFIED_DEVICES=true`). Requires `MEETS_DEVICE_INTEGRITY` and `appRecognitionVerdict = PLAY_RECOGNIZED`; otherwise the device is created with `status = 'quarantined'`, `status_reason = 'integrity'`. Same pubkey again returns the existing device (idempotent).

Response `201` (or `200` if it existed):
```json
{"device_id": "uuid", "status": "active", "integrity_level": "MEETS_DEVICE_INTEGRITY"}
```

### `DELETE /v1/devices/{id}/data`

Body: `{"ts": "<RFC 3339, within 5 min>", "sig": "<DER sig over JCS of {device_id, op:'erase', ts}>"}`. Calls `erase_device_data(id)`. Response `200 {"tests_deleted": 12}`.

### `GET /v1/nonce?device_id=<uuid>`

Device must exist and be `active`. Inserts into `nonces` (5-minute expiry). Limit 30 per device per hour.
Response `200 {"nonce": "n_<22 base64url chars>", "expires_at": "..."}`.

One nonce per test run. The same nonce goes in the probe URL for each SIM and in the payload.

**Offline runs.** With no connection the app cannot fetch a nonce. It still runs the radio sampling, records every upload as `ok: false, err: "no_network"`, sets `nonce: null`, and queues the payload. A payload with `nonce: null` and any `upload.ok = true` is rejected (`schema_violation`). Its integrity request hash is `base64url(sha256(device_id + "|" + ts))`.

### `GET /v1/pus/nearby?lat=&lng=&r=2000&limit=5`

`r` in metres, max 10000; `limit` max 20. Units with a point, nearest first.
```json
{"units": [{"pu_code": "99-01-01-001", "name": "...", "ward": "...", "lga": "...", "state": "...",
            "lat": 8.49, "lng": 4.55, "geom_source": "inec", "dist_m": 132,
            "progress": {"n_tests": 1, "n_devices": 1, "n_evenings": 1, "measured": false, "needed": 2}}]}
```
`progress` counts accepted evening tests on all carriers together; `needed` = max(0, 3 − n_tests). Units with no point are returned by search only.

### `GET /v1/pus/search?q=&limit=10`

`q` matches a PU code prefix (`99-01`) or a case-insensitive substring of the name. Same item shape without `dist_m`; `lat`/`lng` may be null.

### `POST /v1/tests`

Body: the signed payload (`test-payload.schema.json`, `types.ts` `TestPayload`). Server order:

1. Schema validation (`400 schema_violation`).
2. Device exists; `banned` → `403`; `quarantined` → the test is stored with status `quarantined`, reason `device_quarantined`.
3. Signature (`401 bad_signature`).
4. Duplicate: same `payload_sha256` already stored → `200` with the stored result (idempotent sync).
5. If `nonce` is not null: `consume_nonce(nonce, device_id, interval '7 days')` false → `409 nonce_used` (exists, used) / `410 nonce_expired` (older than 7 days) / `404 unknown_nonce`. Queued payloads may sync days after the run; freshness of a *pass* is guaranteed by the probe, which only accepts uploads within the nonce's 5-minute window.
6. Integrity token in the payload (same verification as registration, request hash = `base64url(sha256(nonce))`, or the offline hash above). Failure → device quarantined, test quarantined `integrity`.
7. Checks below, giving `status`, `reject_reason`, `trust`.
8. Insert `tests`, `test_sims`, `test_cells` in one transaction; if the unit has no point, insert a `pu_location_votes` row and call `recompute_pu_location`.

Response `201` (or `200` for a duplicate):
```json
{"test_id": "uuid", "status": "accepted", "reject_reason": null, "trust": 0.5,
 "progress": {"n_tests": 2, "n_devices": 2, "n_evenings": 1, "measured": false, "needed": 1}}
```

#### Checks (in order; first failure wins)

| Check | Rule | Outcome |
| --- | --- | --- |
| Mock location | `fix.mock = true` | quarantined `mock_location` |
| Accuracy | `fix.acc_m > 30` | rejected `low_accuracy` |
| Place | unit has a point and distance > `PLACE_RADIUS_M` (150) | quarantined `too_far` |
| Teleport | previous test by the device within 24 h with a raw fix implies speed > 150 km/h | quarantined `teleport`, device quarantined |
| Probe receipt | any SIM with `upload.ok = true` but no `probe_receipts` row for `(nonce, slot)` with `bytes = 1572864` | rejected `no_probe_receipt` |
| Mobile network | receipt `asn` known and not in `mobile_asns` | rejected `not_mobile_network` |
| Serving cell | registered cell found in `cells` with a point and range: distance(fix, cell) > `range_m` + 1000 | quarantined `cell_mismatch` |
| Timing advance | LTE registered cell with `ta` and a known cell point: `abs(ta × 78.12 − distance) > max(1000, 0.5 × distance)` | quarantined `ta_mismatch` |
| Clock | `ts` more than 10 minutes after receipt or more than 7 days before | rejected `bad_timestamp` |

`trust` = device `reputation` × place score × outlier factor (1.0 at ingest; the model service re-weights outliers to 0.2 later), clipped to [0, 1]. Place score = 1 when distance ≤ 50 m, falling linearly to 0.5 at 150 m; 0.7 when the unit has no point yet. Quarantined and rejected tests get trust 0.

Android reports `WCDMA`; the API stores it as `UMTS`.

## Probe (`PROBE_BASE`)

### `HEAD /v1/probe/{nonce}/{slot}`

Latency ping. `204`, no body, `cache-control: no-store`. No database access.

### `PUT /v1/probe/{nonce}/{slot}`

`slot` 0–3. Body: exactly 1,572,864 bytes, `content-type: image/jpeg`, max accepted 2 MiB (`413` above). The probe checks the nonce exists and is unexpired (`404 unknown_nonce` / `410 nonce_expired`), reads and discards the body, then inserts `probe_receipts (nonce, sim_slot, bytes, duration_ms, client_ip, asn)`. First receipt per `(nonce, slot)` wins; a repeat returns `409`. ASN comes from an optional iptoasn.com `ip2asn-v4.tsv` file (`IP2ASN_TSV`); null when not loaded.
Response `200 {"received_bytes": 1572864, "server_ms": 18012}` with `cache-control: no-store`.

## Public read endpoints

All `GET`, no auth, `cache-control: public, max-age=60` except night endpoints (`max-age=15`).

### `GET /v1/coverage/{pu_code}`
```json
{"pu_code": "...", "name": "...", "ward": "...", "lga": "...", "state": "...", "lat": 8.49, "lng": 4.55,
 "model_version": "2026-12-08.1",
 "best": {"p": 0.96, "p_lo": 0.9, "p_hi": 0.99, "measured": true, "n_tests": 3},
 "carriers": [{"mcc": 621, "mnc": 30, "carrier": "MTN", "p": 0.92, "p_lo": 0.85, "p_hi": 0.97,
               "n_tests": 3, "n_devices": 2, "n_evenings": 2, "measured": true}]}
```
From `coverage_current` / `coverage_best_carrier`. Unit with no prediction yet: `best: null, carriers: []`.

### `GET /v1/map/coverage?state=99[&lga=1]`
GeoJSON `FeatureCollection` of Point features (units with a point). Properties: `pu_code, name, ward, lga, p_best, p_lo, p_hi, n_tests, measured, carriers` where `carriers` is `{"30": 0.92, "20": 0.5}` (MNC → p). Units with no prediction have `p_best: null`.

### `GET /v1/map/progress?state=99`
```json
{"lgas": [{"lga_code": 1, "lga": "Demo North", "units": 5, "tested": 2, "measured": 1}]}
```

### `GET /v1/register?state=&lga=&format=json|csv&limit=500`
Transmission Risk Register, ascending `p_best` (units with a prediction only). JSON: `{"model_version": "...", "rows": [...]}`; CSV: same columns with a header row, `content-disposition: attachment`.
Columns: `pu_code, name, ward, lga, state, p_best, p_lo, p_hi, n_tests, carriers_seen, suggested_action`.
`carriers_seen` = carrier names with any accepted test, `;`-joined. `suggested_action`: `p_best < 0.2` → `satellite or alternate upload point`; `< 0.5` → `alternate upload point or signal booster`; `< 0.8` → `confirm fallback plan`; else `monitor`.

### `GET /v1/elections`
`{"elections": [{"id", "name", "election_date", "state_codes", "polls_close_at", "is_replay", "snapshot": {"id", "sha256", "frozen_at", "model_version", "tsa_at"} | null}]}`

### `GET /v1/night/{election}/summary`
```json
{"election_id": "replay-demo", "polls_close_at": "...", "minutes_since_close": 95,
 "system_stall": {"active": true, "since": "...", "banner": "Uploads paused system-wide: the cause is not field network coverage"},
 "totals": {"units": 5, "uploaded": 3, "pending": 2, "cancelled": 0},
 "states": [{"state_code": 99, "state": "Demo State", "units": 5, "uploaded": 3, "pending": 2, "cancelled": 0}],
 "updated_at": "..."}
```
`system_stall.active=false` → `since` and `banner` null.

### `GET /v1/night/{election}/units?state=`
GeoJSON points from `public_unit_status` joined to units, plus pending units with no flag yet (bucket `pending`). Properties: `pu_code, name, ward, lga, irev_state, first_seen_at, bucket, review_outcome`.
`bucket` ∈ `uploaded | pending | network_failure_plausible | needs_review | not_enough_tests | held_system_stall`. Never `p_other`, never a class name.

### `GET /v1/method`
`{"model_versions": [{"id", "trained_at", "metrics", "is_current"}], "snapshots": [{"id", "election_id", "model_version", "frozen_at", "sha256", "row_count", "tsa_at"}], "audit_roots": [{"day", "root_hash", "tsa_at"}]}` (hashes hex).

## Reviewer endpoints (Bearer JWT, RLS-enforced)

### `GET /v1/night/{election}/flags?class=UNEXPLAINED_DELAY,WATCH&status=unreviewed,awaiting_second`
`{"flags": [Flag]}`, sorted by `evidence.minutes_pending` descending. `Flag` = `{id, pu_code, class, p_network, p_other, review_status, note, created_at, updated_at, evidence: Evidence, reviews: [{reviewer_id, decision, note, created_at}]}`. A non-reviewer gets `{"flags": []}` (RLS), not an error.

### `POST /v1/flags/{id}/review`
`{"decision": "concern_confirmed" | "explained" | "dismissed", "note": "..."}` (`note` required for `explained`). Inserts into `flag_reviews` as the user. Response `200 {"flag": Flag}`. Second review by the same person → `409`. Not a reviewer → `403 forbidden`.

## Evidence card (`flags.evidence`, written by the watcher)

```json
{"pu_code": "...", "name": "...", "ward": "...", "lga": "...",
 "snapshot_id": "uuid", "snapshot_sha256": "hex",
 "measured": true, "n_tests": 4, "n_devices": 2, "n_evenings": 2,
 "carriers": [{"mnc": 30, "carrier": "MTN", "p": 0.92, "p_lo": 0.85, "p_hi": 0.97}],
 "p_best": 0.96, "p_best_lo": 0.9, "p_best_hi": 0.99,
 "neighbours": [{"pu_code": "...", "name": "...", "dist_m": 640, "uploaded_at": "...", "shared": "ward"}],
 "neighbours_uploaded": 5,
 "minutes_since_close": 140, "minutes_pending": 140,
 "s_t": 0.01, "p_network": 0.02, "p_other": 0.82, "p_delay": 0.16,
 "caveat": "This system cannot see BVAS faults, flat batteries, late starts, insecurity, cancelled polls, tower power cuts or congestion on the day. A flag is a request for human review, not a finding."}
```

## Watcher maths (three-cause plausibility)

Per election, from `elections.config` as frozen in `snapshots.config`:

- `p` = frozen best-carrier score of the unit (1 − Π(1 − p_carrier)); `measured` = any carrier measured; interval width = `p_best_hi − p_best_lo`.
- Strata: strong `p ≥ strong_cut` (0.8), weak `p ≤ weak_cut` (0.4).
- `t` = minutes since `polls_close_at`. `S(t)` = share of strong-stratum units in the same state not uploaded at `t` (floor 0.001).
- `m` = uploaded units sharing the ward or the serving cell, capped at 5.
- `N = (1 − p) · r^m`, `O = p · q`, `D = p · (1 − q) · S(t)` with `q = prior_other_q` (0.05), `r = neighbour_factor_r` (0.3).
- `p_network = N/(N+O+D)`, `p_other = O/(N+O+D)`, `p_delay = D/(N+O+D)`.

System stall (re-evaluated each tick, every 2 minutes):
1. Strong-stratum upload rate over the last `stall_window_min` (20) minutes < `stall_rate_frac` (0.1) × its rate over the 30 minutes before that window;
2. pending share > `stall_pending_frac` (0.05);
3. `|strong_ratio − weak_ratio| < stall_ratio_diff` (0.2), where ratio = recent rate / trailing rate per stratum (a stratum with trailing rate 0 has ratio 1 if its recent rate is 0, else treat as not stalled).
All three → open a `stall_events` row; it closes when condition 1 stops holding.

Classes (pending units only, `t ≥ 0`, checked in order):
1. `HELD_SYSTEM_STALL` while a stall is open.
2. `NOT_MEASURED`: not measured and interval width > `not_measured_interval` (0.4).
3. `PLAUSIBLE_NETWORK`: `p_network ≥ p_network_plausible` (0.6).
4. `UNEXPLAINED_DELAY`: `p_other ≥ p_other_flag` (0.6), measured, and `m ≥ neighbour_min` (3).
5. `WATCH`: otherwise.
When a unit uploads, its flag gets `resolved_at`; reviewed flags are never deleted.

## Watcher control (internal, `Authorization: Bearer WATCHER_ADMIN_TOKEN`)

- `GET /healthz` → `{"ok": true}` (no auth).
- `GET /status` → `{"mode": "live" | "replay" | "idle", "election_id", "speed", "sim_time", "last_tick_at", "stall_active"}`.
- `POST /replay/start` `{"election_id": "replay-demo", "timeline": "<path or name>", "speed": 30}` — clears that replay election's `irev_status`, `stall_events` and unreviewed flags, then plays the timeline.
- `POST /replay/stop`.

Replay file `timeline.jsonl`: one JSON object per line, `{"pu_code": "...", "uploaded_at": "<RFC 3339>"}` or `{"pu_code": "...", "cancelled_at": "..."}`. Units of the election's states not in the file stay pending.
