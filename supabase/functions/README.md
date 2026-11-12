# Edge Functions (Deno, TypeScript)

Not written yet. The schema they write to is in `../migrations`. Planned, one per v1 endpoint the app calls:

| Function | Endpoint | Does |
| --- | --- | --- |
| `devices` | `POST /v1/devices`, `DELETE /v1/devices/{id}/data` | Verify the Play Integrity token, store the ES256 public key; erasure calls `erase_device_data()` |
| `nonce` | `GET /v1/nonce` | Insert into `nonces` (5-minute expiry) |
| `pus-nearby` | `GET /v1/pus/nearby` | PostGIS nearest units with test counts |
| `tests` | `POST /v1/tests` | Verify signature over canonical JSON, `consume_nonce()`, place/radio/ASN checks, trust weight, insert `tests` + `test_sims` + `test_cells` |

All run with the service role. The tables they write have RLS on and no anon or authenticated policies.
