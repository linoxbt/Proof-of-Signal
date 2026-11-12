// Supabase access-token verification (ES256/RS256 via the project JWKS, HS256
// via the shared secret), plus RS256 signing for the Google service-account
// assertion.

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

/** Thrown when the JWKS cannot be fetched: the request fails with 500, not 401. */
export class JwksUnavailable extends Error {}

export interface TokenVerifierOptions {
  /** HS256 secret (SUPABASE_JWT_SECRET), the legacy/fallback signing key. */
  secret?: string | null;
  /** Project URL (SUPABASE_URL): JWKS at `${url}/auth/v1/.well-known/jwks.json`. */
  supabaseUrl?: string | null;
  /** Expected `iss`. Defaults to `${supabaseUrl}/auth/v1` when supabaseUrl is set; unchecked otherwise. */
  issuer?: string | null;
  fetchFn?: typeof fetch;
  /** Minimum gap between JWKS refreshes triggered by unknown kids. */
  minRefreshMs?: number;
}

type AsymAlg = "ES256" | "RS256";
interface CachedKey {
  alg: AsymAlg;
  key: CryptoKey;
}

const ASYM: Record<
  AsymAlg,
  { kty: string; importAlg: EcKeyImportParams | RsaHashedImportParams; verifyAlg: AlgorithmIdentifier | EcdsaParams }
> = {
  ES256: {
    kty: "EC",
    importAlg: { name: "ECDSA", namedCurve: "P-256" },
    verifyAlg: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    kty: "RSA",
    importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyAlg: { name: "RSASSA-PKCS1-v1_5" },
  },
};

/**
 * Verifies Supabase access tokens: ES256/RS256 against the project's JWKS
 * (cached; refreshed when a token names an unknown kid), or HS256 with the
 * shared secret. Requires a signed-in user: `role = authenticated`,
 * `aud = authenticated`, a uuid `sub`, an unexpired `exp`, and `iss` when an
 * issuer is known. The anon and service keys are JWTs too, so the role check
 * matters.
 */
export class AccessTokenVerifier {
  private keys = new Map<string, CachedKey>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private secret: string | null;
  private jwksUrl: string | null;
  private issuer: string | null;
  private fetchFn: typeof fetch;
  private minRefreshMs: number;

  constructor(o: TokenVerifierOptions) {
    this.secret = o.secret || null;
    const base = o.supabaseUrl ? o.supabaseUrl.replace(/\/+$/, "") : null;
    this.jwksUrl = base ? `${base}/auth/v1/.well-known/jwks.json` : null;
    this.issuer = o.issuer || (base ? `${base}/auth/v1` : null);
    this.fetchFn = o.fetchFn ?? fetch;
    this.minRefreshMs = o.minRefreshMs ?? 30_000;
  }

  get configured(): boolean {
    return this.secret !== null || this.jwksUrl !== null;
  }

  private async refresh(): Promise<void> {
    if (!this.jwksUrl) return;
    if (this.inflight) return await this.inflight;
    this.inflight = (async () => {
      let body: { keys?: Record<string, unknown>[] };
      try {
        const res = await this.fetchFn(this.jwksUrl!, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
      } catch (e) {
        throw new JwksUnavailable(`JWKS fetch failed: ${(e as Error).message}`);
      }
      const next = new Map<string, CachedKey>();
      for (const jwk of body.keys ?? []) {
        const alg = (jwk.alg ?? (jwk.kty === "EC" ? "ES256" : jwk.kty === "RSA" ? "RS256" : null)) as AsymAlg | null;
        if (!alg || !(alg in ASYM) || jwk.kty !== ASYM[alg].kty || typeof jwk.kid !== "string") continue;
        if (jwk.use !== undefined && jwk.use !== "sig") continue;
        const pub: JsonWebKey = alg === "ES256"
          ? { kty: "EC", crv: jwk.crv as string, x: jwk.x as string, y: jwk.y as string }
          : { kty: "RSA", n: jwk.n as string, e: jwk.e as string };
        try {
          next.set(jwk.kid, {
            alg,
            key: await crypto.subtle.importKey("jwk", pub, ASYM[alg].importAlg, false, ["verify"]),
          });
        } catch {
          console.warn(`JWKS: skipping unusable key ${jwk.kid}`);
        }
      }
      this.keys = next;
      this.fetchedAt = Date.now();
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async keyFor(kid: string, alg: AsymAlg): Promise<CryptoKey | null> {
    let k = this.keys.get(kid);
    if (!k && (this.fetchedAt === 0 || Date.now() - this.fetchedAt >= this.minRefreshMs)) {
      await this.refresh();
      k = this.keys.get(kid);
    }
    return k && k.alg === alg ? k.key : null;
  }

  async verify(token: string, nowS = Date.now() / 1000): Promise<JwtClaims | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    let sig: Uint8Array;
    try {
      header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
      claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
      sig = b64urlDecode(parts[2]);
    } catch {
      return null;
    }
    if (typeof header !== "object" || header === null || typeof claims !== "object" || claims === null) return null;
    const signed = enc.encode(`${parts[0]}.${parts[1]}`);
    let ok = false;
    if (header.alg === "HS256") {
      if (!this.secret) return null;
      ok = await crypto.subtle.verify("HMAC", await hmacKey(this.secret, ["verify"]), sig as BufferSource, signed);
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      if (!this.jwksUrl || typeof header.kid !== "string") return null;
      const key = await this.keyFor(header.kid, header.alg);
      if (!key) return null;
      if (header.alg === "ES256" && sig.length !== 64) return null; // JOSE uses raw r||s
      ok = await crypto.subtle.verify(ASYM[header.alg].verifyAlg, key, sig as BufferSource, signed);
    } else {
      return null; // includes "none"
    }
    if (!ok) return null;
    return checkClaims(claims, nowS, this.issuer);
  }
}

function checkClaims(c: Record<string, unknown>, nowS: number, issuer: string | null): JwtClaims | null {
  if (typeof c.exp !== "number" || c.exp <= nowS) return null;
  if (typeof c.nbf === "number" && c.nbf > nowS + 30) return null;
  const aud = c.aud;
  if (!(aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated")))) return null;
  if (issuer !== null && c.iss !== issuer) return null;
  if (c.role !== "authenticated") return null;
  if (typeof c.sub !== "string" || !UUID_RE.test(c.sub)) return null;
  return c as JwtClaims;
}

/** HS256-only convenience wrapper. */
export async function verifyHs256(token: string, secret: string, nowS = Date.now() / 1000): Promise<JwtClaims | null> {
  return await new AccessTokenVerifier({ secret }).verify(token, nowS);
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
