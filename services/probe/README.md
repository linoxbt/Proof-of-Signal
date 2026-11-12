# Upload probe

The probe receives each phone's 1.5 MB test upload over cellular, throws the body away, and records a receipt in `probe_receipts`. The receipt holds the byte count, the server-side duration, the client IP (kept 24 h) and its ASN. The ingest API accepts an `upload.ok` claim only when a matching receipt exists, so a phone can't fake a pass. The contract is in `contracts/api.md` ("Probe").

| Route | Does |
| --- | --- |
| `HEAD /v1/probe/{nonce}/{slot}` | Latency ping, `204`, no database access |
| `PUT /v1/probe/{nonce}/{slot}` | Checks the nonce exists and is within its 5-minute window, reads up to 2 MiB, records the receipt. `404`/`410` for unknown or expired nonces, `409` for a repeat, `413` over 2 MiB |
| `GET /healthz` | `{"ok": true, "asn_ranges": N}` |

Every response is `cache-control: no-store`.

## Deploying

Run it on separate infrastructure from the API and dashboard: Azure Container Apps, South Africa North, per the spec. Its DNS record must be **DNS-only**: no Cloudflare proxy, no CDN. A proxy would end the connection at its own edge, measure the wrong path, and hide the phone's IP from the mobile-network check. Container Apps' own ingress is a single L7 hop that appends to `X-Forwarded-For`, so set `TRUSTED_PROXY_HOPS=1` there.

| Env | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres URL for a role that can read `nonces` and insert `probe_receipts` |
| `PORT` | `8080` | Listen port |
| `TRUSTED_PROXY_HOPS` | `0` | Reverse proxies in front that append to `X-Forwarded-For` (0 = use the TCP peer) |
| `IP2ASN_TSV` | unset | Path to iptoasn.com `ip2asn-v4.tsv` (public domain). Unset → no ASN, and ingest skips the mobile-network check |
| `MAX_CONCURRENT_UPLOADS` | `200` | More get `503` with `retry-after` |
| `PER_IP_PER_MINUTE` | `120` | Kept generous: many phones share one carrier NAT address |
| `BODY_TIMEOUT_S` | `150` | Body read deadline (the app times out at 120 s) |

```sh
docker build -t pos-probe services/probe
```

## Testing

```sh
cd services/probe && go test ./...
# with the database integration test:
PGDEV_PORT=54334 scripts/db-dev.sh start
PROBE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54334/pos_dev go test -count=1 ./...
```

The tests cover receipts, duplicates per SIM slot, unknown/expired/malformed nonces, the 2 MiB limit, `X-Forwarded-For` hop handling (a client-forged entry is ignored), rate limiting, ASN lookup and the Postgres store.

The spec's load target is 50 concurrent 1.5 MB uploads at p95 under 800 ms ingest, measured with k6. That has not been run yet.
