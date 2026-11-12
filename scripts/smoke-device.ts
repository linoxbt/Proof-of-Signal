// End-to-end smoke test acting as one phone against a running API and probe.
//
//   deno run --allow-net scripts/smoke-device.ts [API_BASE] [PROBE_BASE] [PU_CODE]
//
// Defaults: http://localhost:8000/api, http://localhost:18080, 99-01-01-001.
// The API must run with PLAY_INTEGRITY_MODE=off and ALLOW_UNVERIFIED_DEVICES=true.
// It registers a fresh P-256 key, fetches a nonce, uploads 1.5 MB to the probe,
// signs the payload (RFC 8785 JCS, DER ECDSA) and posts it; then posts an
// offline run (no nonce, upload failed) and replays the first payload to check
// idempotency. Exits non-zero on any unexpected result.
import { canonicalize } from "../supabase/functions/api/lib/jcs.ts";

const API = Deno.args[0] ?? "http://localhost:8000/api";
const PROBE = Deno.args[1] ?? "http://localhost:18080";
const PU = Deno.args[2] ?? "99-01-01-001";

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fail = (msg: string, extra?: unknown) => {
  console.error("FAIL:", msg, extra ?? "");
  Deno.exit(1);
};

// WebCrypto signs as raw r||s; Android (and the contract) use DER.
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, json: json as Record<string, any> };
}

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
const sign = async (obj: Record<string, unknown>) => {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(canonicalize(obj))),
  );
  return { ...obj, sig: b64(rawToDer(raw)) };
};

// 1. Register.
const reg = await call("POST", `${API}/v1/devices`, { pubkey: b64(spki), integrity_token: "dev-build:no-play-integrity", app_version: "smoke" });
if (reg.status !== 201 || reg.json.status !== "active") fail("register", reg);
const deviceId: string = reg.json.device_id;
console.log("registered", deviceId);

// 2. Pick the unit and stand 20 m from it.
const near = await call("GET", `${API}/v1/pus/search?q=${PU}`);
const unit = near.json?.units?.[0];
if (!unit?.lat) fail("unit not found or has no point", near);
const fix = { lat: unit.lat + 0.00018, lng: unit.lng, acc_m: 8, mock: false };

// 3. Nonce, probe pings and upload.
const n = await call("GET", `${API}/v1/nonce?device_id=${deviceId}`);
if (n.status !== 200) fail("nonce", n);
const nonce: string = n.json.nonce;
const latency: number[] = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  const h = await fetch(`${PROBE}/v1/probe/${nonce}/0`, { method: "HEAD" });
  if (h.status !== 204) fail("probe HEAD", h.status);
  latency.push(Math.round(performance.now() - t));
}
const body = new Uint8Array(1_572_864);
for (let i = 0; i < body.length; i += 65536) crypto.getRandomValues(body.subarray(i, i + 65536));
body.set([0xff, 0xd8, 0xff, 0xe0]);
const t0 = performance.now();
const put = await fetch(`${PROBE}/v1/probe/${nonce}/0`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body });
const total = Math.round(performance.now() - t0);
const putJson = await put.json();
if (put.status !== 200) fail("probe PUT", putJson);
console.log("probe receipt", putJson);

// 4. Signed payload. ts in WAT (+01:00).
const wat = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().replace(/\.\d+Z$/, "+01:00");
const sim = (ok: boolean) => ({
  slot: 0,
  mcc_mnc: "621-30",
  net_type: "LTE",
  cells: [{ reg: true, radio: "LTE", sample: 0, mcc: 621, mnc: 30, area: 1234, cid: 5678901, pci: 212, earfcn: 1650, rsrp: -101, rsrq: -12, rssnr: 4, ta: null, level: 2 }],
  latency_ms: ok ? latency : [],
  upload: ok
    ? { ok: true, bytes: 1_572_864, dns_ms: 0, connect_ms: 1, tls_ms: null, ttfb_ms: total, total_ms: total, http_status: 200, err: null }
    : { ok: false, bytes: 0, dns_ms: null, connect_ms: null, tls_ms: null, ttfb_ms: null, total_ms: null, http_status: null, err: "no_network" },
});
const online = await sign({ v: 1, device_id: deviceId, nonce, pu_code: PU, ts: wat(new Date()), fix, sims: [sim(true)], app: "smoke", integrity: "dev-build:no-play-integrity" });
const r1 = await call("POST", `${API}/v1/tests`, online);
console.log("online test", r1.status, r1.json);
if (r1.status !== 201 || r1.json.status !== "accepted") fail("online test not accepted", r1);

// 5. Replay of the same payload: idempotent 200 with the same result.
const r2 = await call("POST", `${API}/v1/tests`, online);
if (r2.status !== 200 || r2.json.test_id !== r1.json.test_id) fail("duplicate not idempotent", r2);
console.log("duplicate", r2.status, "same test_id");

// 6. Offline run: no nonce, upload failed.
const offline = await sign({ v: 1, device_id: deviceId, nonce: null, pu_code: PU, ts: wat(new Date(Date.now() - 60_000)), fix, sims: [sim(false)], app: "smoke", integrity: "dev-build:no-play-integrity" });
const r3 = await call("POST", `${API}/v1/tests`, offline);
console.log("offline test", r3.status, r3.json);
if (r3.status !== 201 || r3.json.status !== "accepted") fail("offline test not accepted", r3);

// 7. A pass claimed with no probe receipt is rejected.
const n2 = await call("GET", `${API}/v1/nonce?device_id=${deviceId}`);
const { sig: _sig, ...unsigned } = online as Record<string, unknown>;
const forged = await sign({ ...unsigned, nonce: n2.json.nonce, ts: wat(new Date(Date.now() - 30_000)) });
const r4 = await call("POST", `${API}/v1/tests`, forged);
console.log("forged pass", r4.status, r4.json?.status, r4.json?.reject_reason);
if (r4.json?.reject_reason !== "no_probe_receipt") fail("forged pass not rejected", r4);

console.log("SMOKE OK");
