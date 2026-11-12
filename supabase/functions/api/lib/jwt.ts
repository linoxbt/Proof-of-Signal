// HS256 JWT verification for Supabase access tokens, plus RS256 signing for
// the Google service-account assertion.

import { b64url, b64urlDecode } from "./crypto.ts";

const enc = new TextEncoder();

export interface JwtClaims {
  sub: string;
  role: string;
  exp?: number;
  [k: string]: unknown;
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies an HS256 token and returns its claims, or null. Requires a signed-in
 * user: `role = authenticated`, a uuid `sub`, and an unexpired `exp`. The anon
 * and service keys are JWTs too, so the role check matters.
 */
export async function verifyHs256(token: string, secret: string, nowS = Date.now() / 1000): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      b64urlDecode(parts[2]) as BufferSource,
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof claims !== "object" || claims === null) return null;
    if (typeof claims.exp !== "number" || claims.exp <= nowS) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowS + 30) return null;
    if (claims.role !== "authenticated") return null;
    if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) return null;
    return claims as JwtClaims;
  } catch {
    return null;
  }
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return b64urlDecode(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export async function signRs256(claims: Record<string, unknown>, pkcs8Pem: string, kid?: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (kid) header.kid = kid;
  const head = b64url(enc.encode(JSON.stringify(header)));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
