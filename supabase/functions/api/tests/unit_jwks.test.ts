import { assertEquals, assertRejects } from "@std/assert";
import { AccessTokenVerifier, JwksUnavailable, signHs256 } from "../lib/jwt.ts";
import { b64url } from "../lib/crypto.ts";

const URL_ = "https://abcd.supabase.co";
const ISS = `${URL_}/auth/v1`;
const SUB = "00000000-0000-0000-0000-00000000b001";
const SECRET = "fallback-secret-0123456789abcdef0123";
const enc = new TextEncoder();

type Alg = "ES256" | "RS256";
async function keyPair(alg: Alg) {
  return alg === "ES256"
    ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
}

async function jwk(kp: CryptoKeyPair, kid: string, alg: Alg) {
  return { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg, use: "sig", key_ops: ["verify"] };
}

async function sign(kp: CryptoKeyPair, alg: Alg, kid: string, claims: Record<string, unknown>, headerAlg = alg) {
  const h = b64url(enc.encode(JSON.stringify({ alg: headerAlg, typ: "JWT", kid })));
  const b = b64url(enc.encode(JSON.stringify(claims)));
  const algo = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const sig = new Uint8Array(await crypto.subtle.sign(algo, kp.privateKey, enc.encode(`${h}.${b}`)));
  return `${h}.${b}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (o: Record<string, unknown> = {}) => ({
  sub: SUB,
  role: "authenticated",
  aud: "authenticated",
  iss: ISS,
  exp: now() + 300,
  ...o,
});

async function setup(minRefreshMs = 0) {
  const ec = await keyPair("ES256");
  const rsa = await keyPair("RS256");
  const jwks = { keys: [await jwk(ec, "ec-1", "ES256"), await jwk(rsa, "rsa-1", "RS256")] };
  const state = { fetches: 0, down: false, jwks };
  const fetchFn = ((input: string | URL | Request) => {
    assertEquals(String(input), `${URL_}/auth/v1/.well-known/jwks.json`);
    state.fetches++;
    if (state.down) return Promise.resolve(new Response("bad gateway", { status: 502 }));
    return Promise.resolve(Response.json(state.jwks));
  }) as typeof fetch;
  const v = new AccessTokenVerifier({ secret: SECRET, supabaseUrl: URL_ + "/", fetchFn, minRefreshMs });
  return { ec, rsa, state, v };
}

Deno.test("jwks: ES256 and RS256 tokens verify against the JWKS, keys are cached", async () => {
  const { ec, rsa, state, v } = await setup();
  assertEquals((await v.verify(await sign(ec, "ES256", "ec-1", claims())))?.sub, SUB);
  assertEquals((await v.verify(await sign(rsa, "RS256", "rsa-1", claims({ aud: ["authenticated", "x"] }))))?.sub, SUB);
  assertEquals(state.fetches, 1);
});

Deno.test("jwks: claim and signature rules", async () => {
  const { ec, rsa, v } = await setup(60_000);
  const bad = async (t: string) => assertEquals(await v.verify(t), null);
  await bad(await sign(ec, "ES256", "ec-1", claims({ exp: now() - 1 })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ exp: undefined })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ aud: "anon" })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ aud: undefined })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ iss: "https://evil.example/auth/v1" })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ role: "anon" })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ role: "service_role" })));
  await bad(await sign(ec, "ES256", "ec-1", claims({ sub: "nope" })));
  // Signed by a key that is not in the JWKS but claims a known kid.
  await bad(await sign(await keyPair("ES256"), "ES256", "ec-1", claims()));
  // Algorithm confusion: RSA key's kid with an ES256 header, and vice versa.
  await bad(await sign(ec, "ES256", "rsa-1", claims()));
  await bad(await sign(rsa, "RS256", "ec-1", claims()));
  // Tampered payload.
  const [h, , s] = (await sign(ec, "ES256", "ec-1", claims())).split(".");
  await bad(`${h}.${b64url(enc.encode(JSON.stringify(claims({ sub: "00000000-0000-0000-0000-00000000c001" }))))}.${s}`);
  // alg none.
  const none = b64url(enc.encode(JSON.stringify({ alg: "none", kid: "ec-1" })));
  await bad(`${none}.${b64url(enc.encode(JSON.stringify(claims())))}.`);
  await bad("not.a.jwt");
});

Deno.test("jwks: unknown kid triggers a refresh (key rotation), rate-limited", async () => {
  const { state, v, ec } = await setup(0);
  await v.verify(await sign(ec, "ES256", "ec-1", claims()));
  const rotated = await keyPair("ES256");
  state.jwks = { keys: [...state.jwks.keys, await jwk(rotated, "ec-2", "ES256")] };
  assertEquals((await v.verify(await sign(rotated, "ES256", "ec-2", claims())))?.sub, SUB);
  assertEquals(state.fetches, 2);

  const slow = await setup(60_000);
  await slow.v.verify(await sign(slow.ec, "ES256", "ec-1", claims()));
  const other = await keyPair("ES256");
  slow.state.jwks = { keys: [...slow.state.jwks.keys, await jwk(other, "ec-9", "ES256")] };
  // Within minRefreshMs an unknown kid is rejected without refetching.
  assertEquals(await slow.v.verify(await sign(other, "ES256", "ec-9", claims())), null);
  assertEquals(slow.state.fetches, 1);
});

Deno.test("jwks: HS256 fallback, outage, and configuration", async () => {
  const { state, v } = await setup();
  assertEquals((await v.verify(await signHs256(claims(), SECRET)))?.sub, SUB);
  assertEquals(await v.verify(await signHs256(claims(), "wrong-secret")), null);
  assertEquals(state.fetches, 0); // HS256 needs no JWKS
  state.down = true;
  const ec = await keyPair("ES256");
  await assertRejects(async () => await v.verify(await sign(ec, "ES256", "ec-1", claims())), JwksUnavailable);

  const hsOnly = new AccessTokenVerifier({ secret: SECRET });
  // No SUPABASE_URL: iss unchecked, asymmetric tokens refused.
  assertEquals((await hsOnly.verify(await signHs256(claims({ iss: "anything" }), SECRET)))?.sub, SUB);
  assertEquals(await hsOnly.verify(await sign(ec, "ES256", "ec-1", claims())), null);
  const jwksOnly = new AccessTokenVerifier({
    supabaseUrl: URL_,
    fetchFn: (() => Promise.resolve(Response.json({ keys: [] }))) as typeof fetch,
  });
  assertEquals(await jwksOnly.verify(await signHs256(claims(), SECRET)), null);
  assertEquals(new AccessTokenVerifier({}).configured, false);
  // Explicit issuer override (local Supabase: functions see SUPABASE_URL=http://kong:8000).
  const custom = new AccessTokenVerifier({
    secret: SECRET,
    supabaseUrl: "http://kong:8000",
    issuer: "http://127.0.0.1:54321/auth/v1",
  });
  assertEquals(
    (await custom.verify(await signHs256(claims({ iss: "http://127.0.0.1:54321/auth/v1" }), SECRET)))?.sub,
    SUB,
  );
  assertEquals(await custom.verify(await signHs256(claims(), SECRET)), null);
});
