// Play Integrity verification.
//
// PLAY_INTEGRITY_MODE=google: the token is decoded by Google's
// `decodeIntegrityToken` REST API, authenticated with an OAuth access token
// obtained from a service-account JWT (RS256, scope playintegrity).
// PLAY_INTEGRITY_MODE=off: no verification; the level is UNVERIFIED, which
// passes only when ALLOW_UNVERIFIED_DEVICES=true.

import { signRs256 } from "./jwt.ts";
import type { Config } from "./config.ts";

export interface IntegrityResult {
  ok: boolean;
  /** Strongest device verdict label, UNVERIFIED (mode off) or NONE. */
  level: string;
  /** Why it failed, for logs. */
  reason: string | null;
}

export interface IntegrityVerifier {
  verify(token: string, expectedRequestHash: string): Promise<IntegrityResult>;
}

/** Thrown for transient upstream failures (network, Google 5xx): the request fails with 500, nothing is quarantined. */
export class IntegrityUnavailable extends Error {}

const LEVELS = ["MEETS_STRONG_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_BASIC_INTEGRITY", "MEETS_VIRTUAL_INTEGRITY"];

// deno-lint-ignore no-explicit-any
type Json = any;

/** Pure verdict evaluation of a decoded `tokenPayloadExternal`. */
export function evaluateVerdict(payload: Json, packageName: string, expectedRequestHash: string): IntegrityResult {
  const verdicts: string[] = Array.isArray(payload?.deviceIntegrity?.deviceRecognitionVerdict)
    ? payload.deviceIntegrity.deviceRecognitionVerdict
    : [];
  const level = LEVELS.find((l) => verdicts.includes(l)) ?? "NONE";
  const fail = (reason: string): IntegrityResult => ({ ok: false, level, reason });
  const rd = payload?.requestDetails ?? {};
  if (rd.requestPackageName !== packageName) return fail("package_mismatch");
  if (rd.requestHash !== expectedRequestHash) return fail("request_hash_mismatch");
  const app = payload?.appIntegrity ?? {};
  if (app.appRecognitionVerdict !== "PLAY_RECOGNIZED") return fail("app_not_play_recognized");
  if (app.packageName !== undefined && app.packageName !== packageName) return fail("app_package_mismatch");
  // MEETS_STRONG_INTEGRITY implies device integrity (Google lists both, but do not rely on it).
  if (!verdicts.includes("MEETS_DEVICE_INTEGRITY") && !verdicts.includes("MEETS_STRONG_INTEGRITY")) {
    return fail("device_integrity_not_met");
  }
  return { ok: true, level, reason: null };
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith("{") ? raw : new TextDecoder().decode(
    Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0)),
  );
  const sa = JSON.parse(text);
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key");
  }
  return sa;
}

export class GoogleIntegrityVerifier implements IntegrityVerifier {
  private accessToken: string | null = null;
  private accessTokenExp = 0;
  private sa: ServiceAccount;

  constructor(
    serviceAccountJson: string,
    private packageName: string,
    private fetchFn: typeof fetch = fetch,
    private timeoutMs = 10_000,
  ) {
    this.sa = parseServiceAccount(serviceAccountJson);
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new IntegrityUnavailable(`fetch ${url}: ${(e as Error).message}`);
    }
  }

  async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && this.accessTokenExp - 60 > now) return this.accessToken;
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const assertion = await signRs256(
      {
        iss: this.sa.client_email,
        scope: "https://www.googleapis.com/auth/playintegrity",
        aud,
        iat: now,
        exp: now + 3600,
      },
      this.sa.private_key,
      this.sa.private_key_id,
    );
    const res = await this.call(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new IntegrityUnavailable(`token endpoint ${res.status}: ${await res.text()}`);
    const body = await res.json();
    this.accessToken = body.access_token;
    this.accessTokenExp = now + (Number(body.expires_in) || 3600);
    return this.accessToken!;
  }

  async verify(token: string, expectedRequestHash: string): Promise<IntegrityResult> {
    if (!token) return { ok: false, level: "NONE", reason: "missing_token" };
    const access = await this.getAccessToken();
    const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`;
    const res = await this.call(url, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ integrity_token: token }),
    });
    if (res.status === 400) {
      // Malformed, tampered or foreign token: a verdict, not an outage.
      await res.body?.cancel();
      return { ok: false, level: "NONE", reason: "invalid_token" };
    }
    if (!res.ok) throw new IntegrityUnavailable(`decodeIntegrityToken ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return evaluateVerdict(body.tokenPayloadExternal, this.packageName, expectedRequestHash);
  }
}

export class OffIntegrityVerifier implements IntegrityVerifier {
  constructor(private allowUnverified: boolean) {}
  verify(): Promise<IntegrityResult> {
    return Promise.resolve(
      this.allowUnverified
        ? { ok: true, level: "UNVERIFIED", reason: null }
        : { ok: false, level: "UNVERIFIED", reason: "unverified_not_allowed" },
    );
  }
}

export function makeVerifier(cfg: Config, fetchFn: typeof fetch = fetch): IntegrityVerifier {
  if (cfg.integrityMode === "off") return new OffIntegrityVerifier(cfg.allowUnverifiedDevices);
  return new GoogleIntegrityVerifier(cfg.googleServiceAccountJson!, cfg.playPackageName!, fetchFn);
}
