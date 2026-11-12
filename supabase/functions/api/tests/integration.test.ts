// End-to-end tests: the real router and handlers against a local Postgres with
// every migration and the seed (scripts/db-dev.sh). Uses state code 98 for its
// own units and cleans its rows at the start, so it can be re-run.
//
//   PGDEV_PORT=54331 scripts/db-dev.sh start
//   DATABASE_URL=postgresql://postgres@127.0.0.1:54331/pos_dev deno task test:integration

import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { loadConfig } from "../lib/config.ts";
import { canonicalBytes } from "../lib/jcs.ts";
import { b64decode, b64encode, b64url, derToRaw, rawToDer } from "../lib/crypto.ts";
import { AccessTokenVerifier, signHs256 } from "../lib/jwt.ts";
import { OffIntegrityVerifier } from "../lib/integrity.ts";
import {
  eveningTs,
  FixtureIntegrity,
  newKey,
  registrationToken,
  signDer,
  signPayload,
  sim,
  type TestKey,
  testToken,
} from "./helpers.ts";
import type { Payload, Sim } from "../lib/schema.ts";

const DB_URL = Deno.env.get("DATABASE_URL") ?? "postgresql://postgres@127.0.0.1:54331/pos_dev";
const JWT_SECRET = "integration-test-secret-0123456789abcdef";
const DASH = "https://dashboard.example.test";

const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const cfg = loadConfig(env({
  DATABASE_URL: DB_URL,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  DASHBOARD_ORIGIN: DASH,
  PLAY_INTEGRITY_MODE: "off",
  RATE_IP_DEVICES_PER_HOUR: "1000",
  RATE_IP_NONCE_PER_HOUR: "1000",
  RATE_IP_TESTS_PER_HOUR: "1000",
}));

const A = "98-01-01-001"; // point (7.0000, 9.0000)
const B = "98-01-01-002"; // point (7.0100, 9.0000)
const C = "98-01-02-001"; // no point: crowd votes
const D = "98-02-01-001"; // point (7.5000, 9.5000), ~77 km from A
const NEAR_A = { lat: 9.0001, lng: 7.0, acc_m: 9, mock: false };
const NEAR_B = { lat: 9.0, lng: 7.0101, acc_m: 8, mock: false };
const AT_D = { lat: 9.5, lng: 7.5, acc_m: 10, mock: false };

const REVIEWER1 = "00000000-0000-0000-0000-00000000b001";
const REVIEWER2 = "00000000-0000-0000-0000-00000000b002";
const OUTSIDER = "00000000-0000-0000-0000-00000000c001";

const db = postgres(DB_URL, { onnotice: () => {}, max: 2 });

async function setup() {
  await db`delete from public.tests where pu_code like '98-%'`;
  await db`delete from public.pu_location_votes where pu_code like '98-%'`;
  await db`
    insert into public.polling_units (pu_code, state, lga, ward, name, geom, geom_source, geom_conf) values
      (${A}, 'Test State', 'Test North', 'Ward T1', 'Test School, "Main" Gate', 'SRID=4326;POINT(7.0000 9.0000)', 'inec', 1),
      (${B}, 'Test State', 'Test North', 'Ward T1', 'Test Market', 'SRID=4326;POINT(7.0100 9.0000)', 'inec', 1),
      (${C}, 'Test State', 'Test North', 'Ward T2', 'Test Village Square', null, null, null),
      (${D}, 'Test State', 'Test South', 'Ward T3', 'Test Health Centre', 'SRID=4326;POINT(7.5000 9.5000)', 'inec', 1)
    on conflict (pu_code) do nothing`;
  await db`update public.polling_units set geom = null, geom_source = null, geom_conf = null where pu_code = ${C}`;
  await db`delete from public.cells where mcc = 621 and mnc = 30 and area = 500`;
  await db`
    insert into public.cells (radio, mcc, mnc, area, cid, geom, range_m) values
      ('LTE', 621, 30, 500, 1001, 'SRID=4326;POINT(7.0000 9.0050)', 2000),
      ('LTE', 621, 30, 500, 1002, 'SRID=4326;POINT(7.3000 9.3000)', 1000),
      ('UMTS', 621, 30, 500, 2001, 'SRID=4326;POINT(7.0000 9.0050)', 3000)`;
  await db`
    insert into auth.users (id, email) values
      (${REVIEWER1}, 'reviewer1@example.test'), (${REVIEWER2}, 'reviewer2@example.test'),
      (${OUTSIDER}, 'outsider@example.test')
    on conflict (id) do nothing`;
  await db`
    insert into public.user_roles (user_id, role, org_id)
    select u, 'reviewer', o.id from public.organisations o,
           unnest(array[${REVIEWER1}, ${REVIEWER2}]::uuid[]) u
    where o.name = 'Demo Observer Group (synthetic)'
    on conflict do nothing`;
}

const app = createApp(cfg, new FixtureIntegrity());

interface Res {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  text: string;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const req = new Request(`http://localhost/functions/v1/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await app.handler(req);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch { /* CSV */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

interface Dev {
  key: TestKey;
  id: string;
}

async function newDevice(token?: string): Promise<Dev & { res: Res }> {
  const key = await newKey();
  const res = await call("POST", "/v1/devices", {
    pubkey: key.pubkey,
    integrity_token: token ?? await registrationToken(key.pubkey),
    app_version: "1.0.0",
  });
  return { key, id: res.body.device_id, res };
}

async function nonceFor(dev: Dev): Promise<string> {
  const r = await call("GET", `/v1/nonce?device_id=${dev.id}`);
  assertEquals(r.status, 200, r.text);
  return r.body.nonce;
}

async function receipt(nonce: string, slot: number, bytes = 1572864, asn: number | null = 29465) {
  await db`insert into public.probe_receipts (nonce, sim_slot, bytes, duration_ms, client_ip, asn)
           values (${nonce}, ${slot}, ${bytes}, 18012, '102.89.1.2', ${asn})`;
}

interface TestOpts {
  nonce?: string | null;
  pu?: string;
  ts?: string;
  fix?: Payload["fix"];
  sims?: Sim[];
  integrity?: string;
}

async function buildTest(dev: Dev, o: TestOpts = {}): Promise<Payload> {
  const nonce = o.nonce === undefined ? await nonceFor(dev) : o.nonce;
  const ts = o.ts ?? eveningTs();
  return await signPayload(dev.key, {
    v: 1,
    device_id: dev.id,
    nonce,
    pu_code: o.pu ?? A,
    ts,
    fix: o.fix ?? NEAR_A,
    // The default serving cell (cid 1001) is near A and B; elsewhere send no cells.
    sims: o.sims ?? [sim(0, false, [A, B].includes(o.pu ?? A) ? {} : { cells: [] })],
    app: "1.0.0",
    integrity: o.integrity ?? await testToken(nonce, dev.id, ts),
  });
}

async function postTest(dev: Dev, o: TestOpts = {}): Promise<Res & { payload: Payload }> {
  const payload = await buildTest(dev, o);
  return { ...(await call("POST", "/v1/tests", payload)), payload };
}

/** Returns the other valid encoding of an ECDSA signature: (r, n - s). */
function malleate(sigB64: string): string {
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const raw = derToRaw(b64decode(sigB64));
  const s = BigInt("0x" + Array.from(raw.subarray(32), (b) => b.toString(16).padStart(2, "0")).join(""));
  const s2 = (n - s).toString(16).padStart(64, "0");
  const out = new Uint8Array(raw);
  for (let i = 0; i < 32; i++) out[32 + i] = parseInt(s2.slice(i * 2, i * 2 + 2), 16);
  return b64encode(rawToDer(out));
}

async function jwt(sub: string, role = "authenticated") {
  return await signHs256(
    { sub, role, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, email: `${sub}@example.test` },
    JWT_SECRET,
  );
}

Deno.test({
  name: "api integration",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await setup();
    const T = eveningTs();

    await t.step("POST /v1/devices registers, is idempotent, quarantines failed integrity", async () => {
      const d = await newDevice();
      assertEquals(d.res.status, 201);
      assertEquals(d.res.body.status, "active");
      assertEquals(d.res.body.integrity_level, "MEETS_DEVICE_INTEGRITY");
      const again = await call("POST", "/v1/devices", {
        pubkey: d.key.pubkey,
        integrity_token: await registrationToken(d.key.pubkey),
      });
      assertEquals(again.status, 200);
      assertEquals(again.body.device_id, d.id);
      const bad = await newDevice("pass:not-bound-to-this-key");
      assertEquals(bad.res.status, 201);
      assertEquals(bad.res.body.status, "quarantined");
      const [row] = await db`select status_reason from public.devices where id = ${bad.id}`;
      assertEquals(row.status_reason, "integrity");
      const inv = await call("POST", "/v1/devices", { pubkey: "AAAA", integrity_token: "x" });
      assertEquals(inv.status, 400);
      assertEquals(inv.body.error.code, "invalid_body");
      const notJson = await call("POST", "/v1/devices", "{nope");
      assertEquals(notJson.body.error.code, "invalid_body");
    });

    await t.step("PLAY_INTEGRITY_MODE=off: UNVERIFIED, allowed only with ALLOW_UNVERIFIED_DEVICES", async () => {
      for (const allow of [true, false]) {
        const offApp = createApp(cfg, new OffIntegrityVerifier(allow));
        const key = await newKey();
        const res = await offApp.handler(
          new Request("http://localhost/api/v1/devices", {
            method: "POST",
            body: JSON.stringify({ pubkey: key.pubkey, integrity_token: "" }),
          }),
        );
        const body = await res.json();
        assertEquals(res.status, 201);
        assertEquals(body.integrity_level, "UNVERIFIED");
        assertEquals(body.status, allow ? "active" : "quarantined");
        await offApp.close();
      }
    });

    await t.step("GET /v1/nonce: format, unknown, quarantined, bad query", async () => {
      const d = await newDevice();
      const r = await call("GET", `/v1/nonce?device_id=${d.id}`);
      assertEquals(r.status, 200);
      assertMatch(r.body.nonce, /^n_[A-Za-z0-9_-]{22}$/);
      assert(Date.parse(r.body.expires_at) - Date.now() > 4 * 60_000);
      assertEquals(r.headers.get("cache-control"), "no-store");
      const unknown = await call("GET", `/v1/nonce?device_id=${crypto.randomUUID()}`);
      assertEquals([unknown.status, unknown.body.error.code], [404, "not_found"]);
      const badq = await call("GET", `/v1/nonce?device_id=xyz`);
      assertEquals([badq.status, badq.body.error.code], [400, "invalid_query"]);
      const q = await newDevice("fail");
      const qr = await call("GET", `/v1/nonce?device_id=${q.id}`);
      assertEquals([qr.status, qr.body.error.code], [403, "device_quarantined"]);
      await db`update public.devices set status = 'banned' where id = ${q.id}`;
      const br = await call("GET", `/v1/nonce?device_id=${q.id}`);
      assertEquals([br.status, br.body.error.code], [403, "device_banned"]);
    });

    await t.step("GET /v1/nonce: 30 per device per hour, then 429 with retry-after", async () => {
      const d = await newDevice();
      for (let i = 0; i < 30; i++) await nonceFor(d);
      const r = await call("GET", `/v1/nonce?device_id=${d.id}`);
      assertEquals([r.status, r.body.error.code], [429, "rate_limited"]);
      assert(Number(r.headers.get("retry-after")) > 3000);
    });

    let accepted: Res & { payload: Payload };
    let acceptedDev: Dev;
    await t.step("POST /v1/tests: accepted pass with probe receipt, stored rows, WCDMA->UMTS", async () => {
      acceptedDev = await newDevice();
      const nonce = await nonceFor(acceptedDev);
      await receipt(nonce, 0);
      const s0 = sim(0, true);
      const s1 = sim(1, false, {
        mcc_mnc: "621-20",
        net_type: "HSPA",
        cells: [
          { reg: true, radio: "WCDMA", sample: 0, mcc: 621, mnc: 20, area: 77, cid: 9999, rssi: -80 },
          { reg: false, radio: "WCDMA", sample: 1, pci: 300 },
        ],
      });
      accepted = await postTest(acceptedDev, { nonce, sims: [s0, s1] });
      assertEquals(accepted.status, 201, accepted.text);
      assertEquals(accepted.body.status, "accepted");
      assertEquals(accepted.body.reject_reason, null);
      assertEquals(accepted.body.trust, 0.5); // reputation 0.5 x place 1 (11 m)
      assertEquals(accepted.body.progress, { n_tests: 1, n_devices: 1, n_evenings: 1, measured: false, needed: 2 });
      const id = accepted.body.test_id;
      const [t1] = await db`
        select status, encode(payload_sha256, 'hex') as sha, is_evening, dist_to_pu_m, geohash7, payload_raw ->> 'sig' as sig
        from public.tests where id = ${id}`;
      assert(t1.is_evening);
      assert(t1.dist_to_pu_m < 15);
      assertEquals(t1.sig, accepted.payload.sig);
      const expectSha = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes(accepted.payload) as BufferSource)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      assertEquals(t1.sha, expectSha);
      const sims =
        await db`select sim_slot, mcc, mnc, upload_ok, success, latency_ms::text as latency_ms from public.test_sims
                            where test_id = ${id} order by sim_slot`;
      assertEquals(sims.length, 2);
      assertEquals(sims[0].success, true);
      assertEquals(sims[0].latency_ms, "{120,NULL,140}");
      assertEquals([sims[1].mnc, sims[1].upload_ok], [20, false]);
      const cells =
        await db`select radio::text, reg, sim_slot from public.test_cells where test_id = ${id} order by id`;
      assertEquals(cells.map((c) => c.radio), ["LTE", "UMTS", "UMTS"]);
    });

    await t.step("POST /v1/tests: duplicate returns the stored result with 200", async () => {
      const dup = await call("POST", "/v1/tests", accepted.payload);
      assertEquals(dup.status, 200);
      assertEquals(dup.body.test_id, accepted.body.test_id);
      assertEquals(dup.body.status, "accepted");
    });

    await t.step("POST /v1/tests: nonce errors", async () => {
      const reuse = await postTest(acceptedDev, { nonce: accepted.payload.nonce, ts: eveningTs(0, 1) });
      assertEquals([reuse.status, reuse.body.error.code], [409, "nonce_used"]);
      const unknown = await postTest(acceptedDev, { nonce: "n_" + "Z".repeat(22) });
      assertEquals([unknown.status, unknown.body.error.code], [404, "unknown_nonce"]);
      const other = await newDevice();
      const othersNonce = await nonceFor(other);
      const foreign = await postTest(acceptedDev, { nonce: othersNonce });
      assertEquals([foreign.status, foreign.body.error.code], [404, "unknown_nonce"]);
      const old = "n_" + crypto.randomUUID().replace(/-/g, "").slice(0, 22);
      await db`insert into public.nonces (nonce, device_id, issued_at, expires_at)
               values (${old}, ${acceptedDev.id}, now() - interval '8 days', now() - interval '8 days' + interval '5 minutes')`;
      const expired = await postTest(acceptedDev, { nonce: old });
      assertEquals([expired.status, expired.body.error.code], [410, "nonce_expired"]);
      // A failed request does not burn the nonce: the unit-not-found case rolls back.
      const n = await nonceFor(acceptedDev);
      const missingPu = await postTest(acceptedDev, { nonce: n, pu: "98-09-09-999" });
      assertEquals([missingPu.status, missingPu.body.error.code], [404, "not_found"]);
      const [nr] = await db`select used_at from public.nonces where nonce = ${n}`;
      assertEquals(nr.used_at, null);
    });

    await t.step("POST /v1/tests: schema, unknown device, bad signature, banned", async () => {
      const p = await buildTest(acceptedDev);
      const bad = await call("POST", "/v1/tests", { ...p, extra: true });
      assertEquals([bad.status, bad.body.error.code], [400, "schema_violation"]);
      const offlinePass = await call("POST", "/v1/tests", { ...p, nonce: null, sims: [sim(0, true)] });
      assertEquals(offlinePass.body.error.code, "schema_violation");
      const tampered = await call("POST", "/v1/tests", { ...p, fix: { ...p.fix, lat: 9.0002 } });
      assertEquals([tampered.status, tampered.body.error.code], [401, "bad_signature"]);
      const stranger = await newKey();
      const forged = await signPayload(stranger, { ...p, sig: undefined } as unknown as Payload);
      const f = await call("POST", "/v1/tests", forged);
      assertEquals(f.body.error.code, "bad_signature");
      const ghost = await call("POST", "/v1/tests", { ...p, device_id: crypto.randomUUID() });
      assertEquals([ghost.status, ghost.body.error.code], [404, "not_found"]);
      const b = await newDevice();
      const bp = await buildTest(b);
      await db`update public.devices set status = 'banned' where id = ${b.id}`;
      const banned = await call("POST", "/v1/tests", bp);
      assertEquals([banned.status, banned.body.error.code], [403, "device_banned"]);
    });

    await t.step("POST /v1/tests: each check outcome", async () => {
      const expect = async (o: TestOpts, status: string, reason: string, before?: (n: string) => Promise<void>) => {
        const d = await newDevice();
        const nonce = o.nonce === undefined ? await nonceFor(d) : o.nonce;
        if (before && nonce) await before(nonce);
        const r = await postTest(d, { ...o, nonce });
        assertEquals(r.status, 201, r.text);
        assertEquals([r.body.status, r.body.reject_reason], [status, reason], JSON.stringify(o));
        assertEquals(r.body.trust, 0);
        return { d, r };
      };
      await expect({ fix: { ...NEAR_A, mock: true } }, "quarantined", "mock_location");
      await expect({ fix: { ...NEAR_A, acc_m: 45 } }, "rejected", "low_accuracy");
      await expect({ fix: { lat: 9.0045, lng: 7.0, acc_m: 9, mock: false } }, "quarantined", "too_far"); // ~500 m
      await expect({ sims: [sim(0, true)] }, "rejected", "no_probe_receipt");
      await expect({ sims: [sim(0, true)] }, "rejected", "no_probe_receipt", (n) => receipt(n, 0, 1000));
      await expect({ sims: [sim(0, true)] }, "rejected", "not_mobile_network", (n) => receipt(n, 0, 1572864, 15169));
      const far = sim(0, false);
      far.cells = [{ reg: true, radio: "LTE", sample: 0, mcc: 621, mnc: 30, area: 500, cid: 1002 }];
      await expect({ sims: [far] }, "quarantined", "cell_mismatch");
      const ta = sim(0, false);
      ta.cells = [{ reg: true, radio: "LTE", sample: 0, mcc: 621, mnc: 30, area: 500, cid: 1001, ta: 40 }];
      await expect({ sims: [ta] }, "quarantined", "ta_mismatch");
      // WCDMA serving cell matched against the UMTS row (within range): accepted path.
      const umts = sim(0, false, { net_type: "HSPA" });
      umts.cells = [{ reg: true, radio: "WCDMA", sample: 0, mcc: 621, mnc: 30, area: 500, cid: 2001 }];
      const d = await newDevice();
      const ok = await postTest(d, { sims: [umts] });
      assertEquals(ok.body.status, "accepted");
      const eightDays = new Date(Date.now() - 8 * 86_400_000).toISOString();
      await expect({ ts: eightDays }, "rejected", "bad_timestamp");
      const future = new Date(Date.now() + 20 * 60_000).toISOString();
      const { r } = await expect({ ts: future }, "rejected", "bad_timestamp");
      const [row] =
        await db`select captured_at, payload_raw ->> 'ts' as raw_ts from public.tests where id = ${r.body.test_id}`;
      assertEquals(row.raw_ts, future);
      assert(new Date(row.captured_at).getTime() < Date.parse(future));
    });

    await t.step("POST /v1/tests: teleport quarantines the device; later tests are device_quarantined", async () => {
      const d = await newDevice();
      const [n1, n2, n3] = [await nonceFor(d), await nonceFor(d), await nonceFor(d)];
      const t1 = await postTest(d, { nonce: n1, ts: T });
      assertEquals(t1.body.status, "accepted");
      const t2 = await postTest(d, { nonce: n2, pu: D, fix: AT_D, ts: eveningTs(0, 10) });
      assertEquals([t2.body.status, t2.body.reject_reason], ["quarantined", "teleport"]);
      const [dev] = await db`select status, status_reason from public.devices where id = ${d.id}`;
      assertEquals([dev.status, dev.status_reason], ["quarantined", "teleport"]);
      const t3 = await postTest(d, { nonce: n3, ts: eveningTs(0, 20) });
      assertEquals([t3.status, t3.body.status, t3.body.reject_reason], [201, "quarantined", "device_quarantined"]);
      const nr = await call("GET", `/v1/nonce?device_id=${d.id}`);
      assertEquals(nr.body.error.code, "device_quarantined");
    });

    await t.step("POST /v1/tests: integrity token not bound to the nonce quarantines test and device", async () => {
      const d = await newDevice();
      const r = await postTest(d, { integrity: "pass:some-other-hash" });
      assertEquals([r.status, r.body.status, r.body.reject_reason], [201, "quarantined", "integrity"]);
      const [dev] = await db`select status, status_reason from public.devices where id = ${d.id}`;
      assertEquals([dev.status, dev.status_reason], ["quarantined", "integrity"]);
    });

    await t.step("POST /v1/tests: offline run (null nonce) is accepted and deduplicated", async () => {
      const d = await newDevice();
      const r = await postTest(d, { nonce: null, pu: D, fix: AT_D, ts: eveningTs(1) });
      assertEquals([r.status, r.body.status], [201, "accepted"], r.text);
      const [row] = await db`select nonce from public.tests where id = ${r.body.test_id}`;
      assertEquals(row.nonce, null);
      const dup = await call("POST", "/v1/tests", r.payload);
      assertEquals([dup.status, dup.body.test_id], [200, r.body.test_id]);
      // Malleated signature (s -> n - s): still valid, new payload_sha256, same run.
      const resigned = { ...r.payload, sig: malleate(r.payload.sig) };
      assert(resigned.sig !== r.payload.sig);
      const dup2 = await call("POST", "/v1/tests", resigned);
      assertEquals([dup2.status, dup2.body.test_id], [200, r.body.test_id]);
      // Offline integrity is bound to device_id|ts.
      const wrong = await postTest(d, {
        nonce: null,
        pu: D,
        fix: AT_D,
        ts: eveningTs(1, 5),
        integrity: await testToken(null, d.id, T),
      });
      assertEquals(wrong.body.reject_reason, "integrity");
    });

    await t.step("POST /v1/tests: daily cap quarantines the 4th test with zero trust", async () => {
      const d = await newDevice();
      const out = [];
      for (let i = 0; i < 4; i++) {
        out.push(await postTest(d, { nonce: null, pu: D, fix: AT_D, ts: eveningTs(2, i) }));
      }
      assertEquals(out.map((r) => r.body.status), ["accepted", "accepted", "accepted", "quarantined"]);
      assertEquals(out[3].body.reject_reason, "daily_cap");
      assertEquals(out[3].body.trust, 0);
    });

    await t.step("progress: measured after 3 tests, 2 devices, 2 evenings", async () => {
      const p1 = await newDevice();
      const p2 = await newDevice();
      const a = await postTest(p1, { pu: B, fix: NEAR_B, ts: T });
      assertEquals(a.body.progress.n_tests, 1);
      const b = await postTest(p2, { pu: B, fix: NEAR_B, nonce: null, ts: eveningTs(1) });
      assertEquals(b.body.progress, { n_tests: 2, n_devices: 2, n_evenings: 2, measured: false, needed: 1 });
      const c = await postTest(p1, { pu: B, fix: NEAR_B, ts: eveningTs(0, 5) });
      assertEquals(c.body.progress, { n_tests: 3, n_devices: 2, n_evenings: 2, measured: true, needed: 0 });
    });

    await t.step("crowd location: 3 independent accepted fixes give a unit with no point a crowd point", async () => {
      for (let i = 0; i < 3; i++) {
        const d = await newDevice();
        const r = await postTest(d, { pu: C, fix: { lat: 9.2 + i * 0.00001, lng: 7.2, acc_m: 10, mock: false } });
        assertEquals([r.body.status, r.body.trust], ["accepted", 0.35]); // 0.5 x 0.7 (no point)
      }
      const [u] = await db`select geom_source::text, extensions.st_y(geom::extensions.geometry) as lat
                           from public.polling_units where pu_code = ${C}`;
      assertEquals(u.geom_source, "crowd");
      assert(Math.abs(u.lat - 9.20001) < 1e-6);
      const votes = await db`select count(*)::int as n from public.pu_location_votes where pu_code = ${C}`;
      assertEquals(votes[0].n, 3);
    });

    await t.step("DELETE /v1/devices/{id}/data erases with a signed request", async () => {
      const d = await newDevice();
      await postTest(d, { nonce: null, ts: eveningTs(3) });
      await postTest(d, { nonce: null, ts: eveningTs(3, 1) });
      const ts = new Date().toISOString();
      const sig = await signDer(d.key, canonicalBytes({ device_id: d.id, op: "erase", ts }));
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      const staleSig = await signDer(d.key, canonicalBytes({ device_id: d.id, op: "erase", ts: stale }));
      const r1 = await call("DELETE", `/v1/devices/${d.id}/data`, { ts: stale, sig: staleSig });
      assertEquals([r1.status, r1.body.error.code], [401, "bad_signature"]);
      const other = await newKey();
      const forged = await signDer(other, canonicalBytes({ device_id: d.id, op: "erase", ts }));
      const r2 = await call("DELETE", `/v1/devices/${d.id}/data`, { ts, sig: forged });
      assertEquals(r2.body.error.code, "bad_signature");
      const ok = await call("DELETE", `/v1/devices/${d.id}/data`, { ts, sig });
      assertEquals([ok.status, ok.body], [200, { tests_deleted: 2 }]);
      const [n] = await db`select count(*)::int as n from public.devices where id = ${d.id}`;
      assertEquals(n.n, 0);
      const again = await call("DELETE", `/v1/devices/${d.id}/data`, { ts, sig });
      assertEquals(again.status, 404);
    });

    await t.step("GET /v1/pus/nearby and /v1/pus/search", async () => {
      const r = await call("GET", "/v1/pus/nearby?lat=9.0001&lng=7.0&r=2000&limit=5");
      assertEquals(r.status, 200);
      assertEquals(r.headers.get("cache-control"), "public, max-age=60");
      assertEquals(r.headers.get("access-control-allow-origin"), "*");
      assertEquals(r.body.units.map((u: { pu_code: string }) => u.pu_code), [A, B]);
      const a = r.body.units[0];
      assertEquals(a.geom_source, "inec");
      assert(a.dist_m >= 10 && a.dist_m <= 12, String(a.dist_m));
      assert(a.progress.n_tests >= 2);
      const bad = await call("GET", "/v1/pus/nearby?lat=9&lng=7&r=20000");
      assertEquals([bad.status, bad.body.error.code], [400, "invalid_query"]);
      const s = await call("GET", "/v1/pus/search?q=98-01&limit=10");
      assertEquals(s.body.units.map((u: { pu_code: string }) => u.pu_code), [A, B, C]);
      assertEquals("dist_m" in s.body.units[0], false);
      const byName = await call("GET", "/v1/pus/search?q=village%20SQUARE");
      assert(byName.body.units.some((u: { pu_code: string }) => u.pu_code === C));
      const pct = await call("GET", "/v1/pus/search?q=%25");
      assertEquals(pct.body.units.length, 0);
    });

    const modelId = `it-${crypto.randomUUID().slice(0, 8)}`;
    const electionId = `it-${crypto.randomUUID().slice(0, 8)}`;
    let snapshotId = "";
    await t.step("coverage, map and register endpoints", async () => {
      const none = await call("GET", `/v1/coverage/${C}`);
      assertEquals(none.status, 200);
      // C may have a prediction from an earlier run's model; only check shape.
      await db`update public.model_versions set is_current = false where is_current`;
      await db`insert into public.model_versions (id, feature_version, metrics, is_current)
               values (${modelId}, 'f1', '{"auc": 0.81}', true)`;
      await db`
        insert into public.predictions (pu_code, mcc, mnc, model_version, p_model, p, p_lo, p_hi, n_tests, n_devices, n_evenings, measured)
        values (${A}, 621, 30, ${modelId}, 0.1, 0.1, 0.05, 0.2, 2, 2, 1, false),
               (${A}, 621, 20, ${modelId}, 0.05, 0.05, 0.01, 0.1, 0, 0, 0, false),
               (${B}, 621, 30, ${modelId}, 0.9, 0.9, 0.8, 0.95, 3, 2, 2, true),
               (${D}, 621, 30, ${modelId}, 0.6, 0.6, 0.4, 0.7, 3, 1, 1, false)`;
      const cov = await call("GET", `/v1/coverage/${A}`);
      assertEquals(cov.status, 200);
      assertEquals(cov.body.model_version, modelId);
      assertEquals(cov.body.best, { p: 0.145, p_lo: 0.0595, p_hi: 0.28, measured: false, n_tests: 2 });
      assertEquals(cov.body.carriers.map((c: { carrier: string }) => c.carrier), ["Airtel", "MTN"]);
      assertEquals(cov.body.lat, 9);
      const noPred = await call("GET", `/v1/coverage/${C}`);
      assertEquals([noPred.body.best, noPred.body.carriers, noPred.body.model_version], [null, [], null]);
      assertEquals((await call("GET", "/v1/coverage/98-77-77-777")).status, 404);

      const map = await call("GET", "/v1/map/coverage?state=98&lga=1");
      assertEquals(map.body.type, "FeatureCollection");
      const fa = map.body.features.find((f: { properties: { pu_code: string } }) => f.properties.pu_code === A);
      assertEquals(fa.geometry, { type: "Point", coordinates: [7, 9] });
      assertEquals(fa.properties.carriers, { "20": 0.05, "30": 0.1 });
      assertEquals(fa.properties.p_best, 0.145);
      const fc = map.body.features.find((f: { properties: { pu_code: string } }) => f.properties.pu_code === C);
      assertEquals(fc.properties.p_best, null); // crowd point, no prediction
      assertEquals(
        map.body.features.some((f: { properties: { pu_code: string } }) => f.properties.pu_code === D),
        false,
      );
      assertEquals((await call("GET", "/v1/map/coverage")).body.error.code, "invalid_query");

      const prog = await call("GET", "/v1/map/progress?state=98");
      assertEquals(prog.body.lgas[0], { lga_code: 1, lga: "Test North", units: 3, tested: 3, measured: 1 });

      const reg = await call("GET", "/v1/register?state=98");
      assertEquals(reg.body.model_version, modelId);
      assertEquals(reg.body.rows.map((x: { pu_code: string }) => x.pu_code), [A, D, B]);
      assertEquals(reg.body.rows[0].suggested_action, "satellite or alternate upload point");
      assertEquals(reg.body.rows[1].suggested_action, "confirm fallback plan");
      assertEquals(reg.body.rows[2].suggested_action, "monitor");
      assertEquals(reg.body.rows[0].carriers_seen, "Airtel;MTN");
      assertEquals(reg.body.rows[2].carriers_seen, "MTN");
      const csv = await call("GET", "/v1/register?state=98&format=csv");
      assertEquals(csv.status, 200);
      assertEquals(csv.headers.get("content-type"), "text/csv; charset=utf-8");
      assertEquals(csv.headers.get("content-disposition"), 'attachment; filename="risk-register-98.csv"');
      const lines = csv.text.trim().split("\r\n");
      assertEquals(lines[0], "pu_code,name,ward,lga,state,p_best,p_lo,p_hi,n_tests,carriers_seen,suggested_action");
      assertEquals(
        lines[1],
        `${A},"Test School, ""Main"" Gate",Ward T1,Test North,Test State,0.145,0.0595,0.28,2,Airtel;MTN,satellite or alternate upload point`,
      );
      assertEquals(lines.length, 4);
      assertEquals((await call("GET", "/v1/register?format=xml")).body.error.code, "invalid_query");
    });

    await t.step("elections and method", async () => {
      await db`insert into public.elections (id, name, election_date, state_codes, polls_close_at)
               values (${electionId}, 'Integration test election', current_date, '{98}', now() - interval '2 hours')`;
      const [s] = await db`select public.freeze_snapshot(${electionId}, ${modelId}) as id`;
      snapshotId = s.id;
      const el = await call("GET", "/v1/elections");
      const e = el.body.elections.find((x: { id: string }) => x.id === electionId);
      assertEquals(e.state_codes, [98]);
      assertEquals(e.is_replay, false);
      assertEquals(e.snapshot.id, snapshotId);
      assertMatch(e.snapshot.sha256, /^[0-9a-f]{64}$/);
      assertEquals(e.snapshot.model_version, modelId);
      const demo = el.body.elections.find((x: { id: string }) => x.id === "replay-demo");
      assertEquals(demo.snapshot, null);
      const m = await call("GET", "/v1/method");
      const mv = m.body.model_versions.find((x: { id: string }) => x.id === modelId);
      assertEquals([mv.is_current, mv.metrics], [true, { auc: 0.81 }]);
      const ms = m.body.snapshots.find((x: { id: string }) => x.id === snapshotId);
      assertEquals([ms.row_count, ms.sha256], [4, e.snapshot.sha256]);
      assert(Array.isArray(m.body.audit_roots));
    });

    let flagB = "";
    let flagD = "";
    await t.step("night summary and units (public)", async () => {
      await db`insert into public.irev_status (election_id, pu_code, state, first_seen_at) values
                 (${electionId}, ${A}, 'uploaded', now() - interval '1 hour'),
                 (${electionId}, ${B}, 'pending', null),
                 (${electionId}, ${C}, 'cancelled', null)`;
      await db`insert into public.stall_events (election_id, started_at) values (${electionId}, now() - interval '10 minutes')`;
      const ev = (mp: number) => ({
        pu_code: "x",
        minutes_pending: mp,
        p_other: 0.82,
        caveat: "A flag is a request for human review, not a finding.",
      });
      [{ id: flagB }] = await db`
        insert into public.flags (election_id, pu_code, snapshot_id, class, p_network, p_other, evidence)
        values (${electionId}, ${B}, ${snapshotId}, 'UNEXPLAINED_DELAY', 0.02, 0.82, ${db.json(ev(140))}) returning id`;
      [{ id: flagD }] = await db`
        insert into public.flags (election_id, pu_code, snapshot_id, class, p_network, p_other, evidence)
        values (${electionId}, ${D}, ${snapshotId}, 'WATCH', 0.3, 0.5, ${db.json(ev(30))}) returning id`;

      const s = await call("GET", `/v1/night/${electionId}/summary`);
      assertEquals(s.status, 200);
      assertEquals(s.headers.get("cache-control"), "public, max-age=15");
      assertEquals(s.body.totals, { units: 4, uploaded: 1, pending: 2, cancelled: 1 });
      assertEquals(s.body.states[0].state_code, 98);
      assert(s.body.minutes_since_close >= 119 && s.body.minutes_since_close <= 121);
      assertEquals(s.body.system_stall.active, true);
      assertEquals(s.body.system_stall.banner, "Uploads paused system-wide: the cause is not field network coverage");
      assertEquals((await call("GET", "/v1/night/no-such/summary")).status, 404);

      const u = await call("GET", `/v1/night/${electionId}/units`);
      const props = Object.fromEntries(
        u.body.features.map((f: { properties: Record<string, unknown> }) => [f.properties.pu_code, f.properties]),
      );
      assertEquals(props[A].bucket, "uploaded");
      assertEquals(props[A].irev_state, "uploaded");
      assertEquals(props[B].bucket, "needs_review");
      assertEquals(props[D].bucket, "needs_review");
      assertEquals(props[D].irev_state, "pending");
      assertEquals(props[C], undefined); // cancelled
      for (const p of Object.values(props) as Record<string, unknown>[]) {
        assertEquals(Object.keys(p).sort(), [
          "bucket",
          "first_seen_at",
          "irev_state",
          "lga",
          "name",
          "pu_code",
          "review_outcome",
          "ward",
        ]);
      }
      assertEquals(JSON.stringify(u.body).includes("UNEXPLAINED"), false);
    });

    await t.step("reviewer flags: auth, RLS, sorting and filters", async () => {
      const path = `/v1/night/${electionId}/flags`;
      const none = await call("GET", path);
      assertEquals([none.status, none.body.error.code], [401, "unauthenticated"]);
      const anonKey = await signHs256({ role: "anon", exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
      assertEquals((await call("GET", path, undefined, { authorization: `Bearer ${anonKey}` })).status, 401);
      const forged = await signHs256({
        sub: REVIEWER1,
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 600,
      }, "wrong");
      assertEquals((await call("GET", path, undefined, { authorization: `Bearer ${forged}` })).status, 401);

      const outsider = await call("GET", path, undefined, { authorization: `Bearer ${await jwt(OUTSIDER)}` });
      assertEquals([outsider.status, outsider.body], [200, { flags: [] }]);
      assertEquals(outsider.headers.get("cache-control"), "private, no-store");

      const auth = { authorization: `Bearer ${await jwt(REVIEWER1)}` };
      const all = await call("GET", path, undefined, auth);
      assertEquals(all.body.flags.map((f: { id: string }) => f.id), [flagB, flagD]);
      const f0 = all.body.flags[0];
      assertEquals([f0.class, f0.p_other, f0.review_status, f0.reviews], ["UNEXPLAINED_DELAY", 0.82, "unreviewed", []]);
      assertEquals(f0.evidence.minutes_pending, 140);
      const filtered = await call("GET", `${path}?class=WATCH&status=unreviewed,awaiting_second`, undefined, auth);
      assertEquals(filtered.body.flags.map((f: { id: string }) => f.id), [flagD]);
      const badq = await call("GET", `${path}?class=NOPE`, undefined, auth);
      assertEquals(badq.body.error.code, "invalid_query");
    });

    await t.step("reviewer flags with an asymmetric (ES256) token verified against a JWKS", async () => {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
      const base = "https://proj.supabase.test";
      const tokens = new AccessTokenVerifier({
        supabaseUrl: base,
        fetchFn: (() => Promise.resolve(Response.json({ keys: [pub] }))) as typeof fetch,
      });
      const jwksApp = createApp(cfg, new FixtureIntegrity(), tokens);
      const enc = new TextEncoder();
      const h = b64url(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" })));
      const b = b64url(enc.encode(JSON.stringify({
        sub: REVIEWER1,
        role: "authenticated",
        aud: "authenticated",
        iss: `${base}/auth/v1`,
        exp: Math.floor(Date.now() / 1000) + 600,
      })));
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, enc.encode(`${h}.${b}`)),
      );
      const res = await jwksApp.handler(
        new Request(`http://localhost/functions/v1/api/v1/night/${electionId}/flags`, {
          headers: { authorization: `Bearer ${h}.${b}.${b64url(sig)}` },
        }),
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).flags.length, 2);
      const hs = await jwksApp.handler(
        new Request(`http://localhost/functions/v1/api/v1/night/${electionId}/flags`, {
          headers: { authorization: `Bearer ${await jwt(REVIEWER1)}` },
        }),
      );
      assertEquals(hs.status, 401); // no HS256 secret configured on this app
      await jwksApp.close();
    });

    await t.step("reviewer review flow: two-person rule, duplicates, forbidden", async () => {
      const r1 = { authorization: `Bearer ${await jwt(REVIEWER1)}` };
      const r2 = { authorization: `Bearer ${await jwt(REVIEWER2)}` };
      const out = { authorization: `Bearer ${await jwt(OUTSIDER)}` };
      const path = `/v1/flags/${flagB}/review`;

      const forbidden = await call("POST", path, { decision: "dismissed" }, out);
      assertEquals([forbidden.status, forbidden.body.error.code], [403, "forbidden"]);
      assertEquals(forbidden.headers.get("access-control-allow-origin"), DASH);
      const noNote = await call("POST", path, { decision: "explained" }, r1);
      assertEquals([noNote.status, noNote.body.error.code], [400, "invalid_body"]);
      const badDecision = await call("POST", path, { decision: "maybe" }, r1);
      assertEquals(badDecision.body.error.code, "invalid_body");
      assertEquals(
        (await call("POST", `/v1/flags/${crypto.randomUUID()}/review`, { decision: "dismissed" }, r1)).status,
        404,
      );

      const first = await call("POST", path, { decision: "concern_confirmed", note: "No neighbours delayed" }, r1);
      assertEquals(first.status, 200, first.text);
      assertEquals(first.body.flag.review_status, "awaiting_second");
      assertEquals(first.body.flag.reviews.length, 1);
      assertEquals(first.body.flag.reviews[0].reviewer_id, REVIEWER1);
      const again = await call("POST", path, { decision: "dismissed" }, r1);
      assertEquals(again.status, 409);
      const second = await call("POST", path, { decision: "concern_confirmed" }, r2);
      assertEquals(second.body.flag.review_status, "concern_confirmed");
      assertEquals(second.body.flag.reviews.map((x: { reviewer_id: string }) => x.reviewer_id), [REVIEWER1, REVIEWER2]);

      const expl = await call("POST", `/v1/flags/${flagD}/review`, {
        decision: "explained",
        note: "Late start reported",
      }, r2);
      assertEquals([expl.body.flag.review_status, expl.body.flag.note], ["explained", "Late start reported"]);

      const u = await call("GET", `/v1/night/${electionId}/units`);
      const props = Object.fromEntries(
        u.body.features.map((f: { properties: Record<string, unknown> }) => [f.properties.pu_code, f.properties]),
      );
      assertEquals(props[B].review_outcome, "concern_raised");
      assertEquals(props[D].review_outcome, "explained");
      const [audit] =
        await db`select count(*)::int as n from public.audit_log where entity = 'flag_reviews' and entity_id = ${flagB}`;
      assertEquals(audit.n, 2);
    });

    await t.step("CORS preflight, unknown route, error shape", async () => {
      const pre = await app.handler(
        new Request("http://localhost/functions/v1/api/v1/tests", {
          method: "OPTIONS",
          headers: { origin: DASH, "access-control-request-method": "POST" },
        }),
      );
      assertEquals(pre.status, 204);
      assertEquals(pre.headers.get("access-control-allow-origin"), DASH);
      const preGet = await app.handler(
        new Request("http://localhost/functions/v1/api/v1/elections", {
          method: "OPTIONS",
          headers: { "access-control-request-method": "GET" },
        }),
      );
      assertEquals(preGet.headers.get("access-control-allow-origin"), "*");
      const nf = await call("GET", "/v1/nope");
      assertEquals([nf.status, Object.keys(nf.body.error).sort()], [404, ["code", "message"]]);
      const wrongMethod = await call("PUT", "/v1/tests", {});
      assertEquals(wrongMethod.status, 404);
    });

    await t.step("per-IP limit returns 429 rate_limited", async () => {
      const tight = createApp({ ...cfg, ipLimitDevices: 1 }, new FixtureIntegrity());
      const mk = async () => {
        const key = await newKey();
        return await tight.handler(
          new Request("http://localhost/api/v1/devices", {
            method: "POST",
            headers: { "cf-connecting-ip": "203.0.113.9" },
            body: JSON.stringify({ pubkey: key.pubkey, integrity_token: await registrationToken(key.pubkey) }),
          }),
        );
      };
      assertEquals((await mk()).status, 201);
      const r = await mk();
      assertEquals(r.status, 429);
      assertEquals((await r.json()).error.code, "rate_limited");
      assertExists(r.headers.get("retry-after"));
      await tight.close();
    });

    await t.step("over real HTTP with the Supabase path prefix", async () => {
      const ac = new AbortController();
      const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, app.handler);
      const port = (server.addr as Deno.NetAddr).port;
      const res = await fetch(`http://127.0.0.1:${port}/functions/v1/api/v1/elections`);
      assertEquals(res.status, 200);
      assert(Array.isArray((await res.json()).elections));
      ac.abort();
      await server.finished;
    });

    await app.close();
    await db.end();
  },
});
