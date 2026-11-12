import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  evaluateVerdict,
  GoogleIntegrityVerifier,
  IntegrityUnavailable,
  OffIntegrityVerifier,
} from "../lib/integrity.ts";
import { b64encode, b64urlDecode } from "../lib/crypto.ts";
import { signHs256, verifyHs256 } from "../lib/jwt.ts";
import { stripPrefix } from "../lib/router.ts";
import { corsHeaders } from "../lib/http.ts";
import { RateLimiter } from "../lib/ratelimit.ts";
import { csvField, suggestedAction } from "../handlers/public.ts";
import { progress } from "../lib/context.ts";
import { loadConfig } from "../lib/config.ts";

const PKG = "org.proofofsignal.sweep";
const HASH = "q1w2e3r4t5y6u7i8o9p0";

function verdict(over: Record<string, unknown> = {}) {
  return {
    requestDetails: { requestPackageName: PKG, requestHash: HASH, timestampMillis: "1700000000000" },
    appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: PKG, versionCode: "1" },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
    ...over,
  };
}

Deno.test("integrity: verdict evaluation", () => {
  assertEquals(evaluateVerdict(verdict(), PKG, HASH), { ok: true, level: "MEETS_DEVICE_INTEGRITY", reason: null });
  assertEquals(
    evaluateVerdict(
      verdict({
        deviceIntegrity: {
          deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"],
        },
      }),
      PKG,
      HASH,
    ).level,
    "MEETS_STRONG_INTEGRITY",
  );
  const basic = evaluateVerdict(
    verdict({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } }),
    PKG,
    HASH,
  );
  assertEquals(basic, { ok: false, level: "MEETS_BASIC_INTEGRITY", reason: "device_integrity_not_met" });
  assertEquals(evaluateVerdict(verdict({ deviceIntegrity: {} }), PKG, HASH).level, "NONE");
  assertEquals(evaluateVerdict(verdict(), PKG, "other").reason, "request_hash_mismatch");
  assertEquals(evaluateVerdict(verdict(), "com.evil", HASH).reason, "package_mismatch");
  assertEquals(
    evaluateVerdict(verdict({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }), PKG, HASH).reason,
    "app_not_play_recognized",
  );
  assertEquals(evaluateVerdict(undefined, PKG, HASH).ok, false);
});

async function serviceAccount() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    b64encode(pkcs8).replace(/(.{64})/g, "$1\n")
  }\n-----END PRIVATE KEY-----\n`;
  return {
    publicKey: kp.publicKey,
    json: JSON.stringify({
      type: "service_account",
      client_email: "integrity@example-project.iam.gserviceaccount.com",
      private_key: pem,
      private_key_id: "kid-1",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  };
}

Deno.test("integrity: Google flow with service-account JWT, decode call, caching and errors", async () => {
  const sa = await serviceAccount();
  const calls: string[] = [];
  let decodeStatus = 200;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init!.body));
      assertEquals(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, b, s] = form.get("assertion")!.split(".");
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        sa.publicKey,
        b64urlDecode(s) as BufferSource,
        new TextEncoder().encode(`${h}.${b}`),
      );
      assert(ok, "assertion must be signed with the service account key");
      const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
      const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(b)));
      assertEquals(header, { alg: "RS256", typ: "JWT", kid: "kid-1" });
      assertEquals(claims.scope, "https://www.googleapis.com/auth/playintegrity");
      assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
      assertEquals(claims.iss, "integrity@example-project.iam.gserviceaccount.com");
      return Response.json({ access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" });
    }
    assertEquals(url, `https://playintegrity.googleapis.com/v1/${PKG}:decodeIntegrityToken`);
    assertEquals(new Headers(init!.headers).get("authorization"), "Bearer ya29.test");
    const body = JSON.parse(String(init!.body));
    if (decodeStatus !== 200) return new Response("{}", { status: decodeStatus });
    if (body.integrity_token === "good") return Response.json({ tokenPayloadExternal: verdict() });
    return Response.json({
      tokenPayloadExternal: verdict({ deviceIntegrity: { deviceRecognitionVerdict: [] } }),
    });
  }) as typeof fetch;

  const v = new GoogleIntegrityVerifier(sa.json, PKG, fakeFetch);
  assertEquals((await v.verify("good", HASH)).ok, true);
  assertEquals((await v.verify("good", "wrong-hash")).reason, "request_hash_mismatch");
  assertEquals((await v.verify("rooted", HASH)).reason, "device_integrity_not_met");
  assertEquals((await v.verify("", HASH)).reason, "missing_token");
  // One token exchange, cached across decode calls.
  assertEquals(calls.filter((c) => c.includes("oauth2")).length, 1);
  decodeStatus = 400;
  assertEquals(await v.verify("garbage", HASH), { ok: false, level: "NONE", reason: "invalid_token" });
  decodeStatus = 503;
  await assertRejects(() => v.verify("good", HASH), IntegrityUnavailable);
  const down = new GoogleIntegrityVerifier(
    sa.json,
    PKG,
    (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch,
  );
  await assertRejects(() => down.verify("good", HASH), IntegrityUnavailable);
});

Deno.test("integrity: off mode", async () => {
  assertEquals(await new OffIntegrityVerifier(true).verify(), { ok: true, level: "UNVERIFIED", reason: null });
  assertFalse((await new OffIntegrityVerifier(false).verify()).ok);
});

Deno.test("config: google mode needs credentials; off mode does not", () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  let threw = false;
  try {
    loadConfig(env({ DATABASE_URL: "postgres://x" }));
  } catch {
    threw = true;
  }
  assert(threw);
  const c = loadConfig(
    env({ SUPABASE_DB_URL: "postgres://y", PLAY_INTEGRITY_MODE: "off", ALLOW_UNVERIFIED_DEVICES: "true" }),
  );
  assertEquals(c.databaseUrl, "postgres://y");
  assertEquals(c.allowUnverifiedDevices, true);
  assertEquals(c.placeRadiusM, 150);
});

Deno.test("jwt: HS256 verification rules", async () => {
  const secret = "test-secret-with-at-least-32-characters!!";
  const now = Math.floor(Date.now() / 1000);
  const sub = "00000000-0000-0000-0000-00000000b001";
  const good = await signHs256({ sub, role: "authenticated", aud: "authenticated", exp: now + 60 }, secret);
  assertEquals((await verifyHs256(good, secret))?.sub, sub);
  assertEquals(await verifyHs256(good, "another-secret"), null);
  assertEquals(await verifyHs256(await signHs256({ sub, role: "authenticated", exp: now - 1 }, secret), secret), null);
  assertEquals(await verifyHs256(await signHs256({ sub, role: "authenticated" }, secret), secret), null);
  assertEquals(await verifyHs256(await signHs256({ role: "anon", exp: now + 60 }, secret), secret), null);
  assertEquals(
    await verifyHs256(await signHs256({ sub: "x", role: "authenticated", exp: now + 60 }, secret), secret),
    null,
  );
  const [h, b] = good.split(".");
  assertEquals(await verifyHs256(`${h}.${b}.`, secret), null);
  assertEquals(await verifyHs256("garbage", secret), null);
  const none = btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "");
  assertEquals(await verifyHs256(`${none}.${b}.`, secret), null);
});

Deno.test("router: prefix stripping", () => {
  assertEquals(stripPrefix("/functions/v1/api/v1/tests"), "/v1/tests");
  assertEquals(stripPrefix("/api/v1/nonce"), "/v1/nonce");
  assertEquals(stripPrefix("/api"), "/");
  assertEquals(stripPrefix("/v1/elections"), "/v1/elections");
  assertEquals(stripPrefix("/apiary/v1/x"), "/apiary/v1/x");
});

Deno.test("cors: GET any origin, others the dashboard", () => {
  assertEquals(corsHeaders("GET", "https://dash.example")["access-control-allow-origin"], "*");
  assertEquals(corsHeaders("POST", "https://dash.example")["access-control-allow-origin"], "https://dash.example");
  assertEquals(corsHeaders("DELETE", "")["access-control-allow-origin"], undefined);
});

Deno.test("rate limiter: fixed window", () => {
  const rl = new RateLimiter(1000);
  assertEquals(rl.hit("k", 2, 0), 0);
  assertEquals(rl.hit("k", 2, 10), 0);
  assertEquals(rl.hit("k", 2, 20), 0.98);
  assertEquals(rl.hit("other", 2, 20), 0);
  assertEquals(rl.hit("k", 2, 1000), 0);
});

Deno.test("register helpers: suggested action, CSV quoting, progress", () => {
  assertEquals(suggestedAction(0.19), "satellite or alternate upload point");
  assertEquals(suggestedAction(0.2), "alternate upload point or signal booster");
  assertEquals(suggestedAction(0.79), "confirm fallback plan");
  assertEquals(suggestedAction(0.8), "monitor");
  assertEquals(csvField('Demo "Big" School, Ward A'), '"Demo ""Big"" School, Ward A"');
  assertEquals(csvField(null), "");
  assertEquals(csvField(0.145), "0.145");
  assertEquals(progress(1, 1, 1), { n_tests: 1, n_devices: 1, n_evenings: 1, measured: false, needed: 2 });
  assertEquals(progress(4, 2, 2), { n_tests: 4, n_devices: 2, n_evenings: 2, measured: true, needed: 0 });
});
