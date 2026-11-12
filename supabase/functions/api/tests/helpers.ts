// Test helpers: device keys that behave like Android Keystore (SPKI pubkey,
// DER signatures), payload builders, and a fixture integrity verifier.

import { b64encode, b64url, rawToDer, sha256 } from "../lib/crypto.ts";
import { canonicalBytes } from "../lib/jcs.ts";
import type { IntegrityResult, IntegrityVerifier } from "../lib/integrity.ts";
import type { Payload, Sim } from "../lib/schema.ts";

export interface TestKey {
  keys: CryptoKeyPair;
  pubkey: string; // base64 SPKI DER
}

export async function newKey(): Promise<TestKey> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  return { keys, pubkey: b64encode(spki) };
}

/** Base64 DER ECDSA signature, as Android's Signature.sign() returns. */
export async function signDer(key: TestKey, data: Uint8Array): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.keys.privateKey, data as BufferSource),
  );
  return b64encode(rawToDer(raw));
}

export async function signPayload(key: TestKey, p: Omit<Payload, "sig"> & { sig?: string }): Promise<Payload> {
  const { sig: _drop, ...unsigned } = p;
  return { ...unsigned, sig: await signDer(key, canonicalBytes(unsigned)) } as Payload;
}

/** Fixture tokens: "pass:<requestHash>" verifies; anything else fails. Exercises the request-hash binding. */
export class FixtureIntegrity implements IntegrityVerifier {
  verify(token: string, expected: string): Promise<IntegrityResult> {
    if (token === `pass:${expected}`) {
      return Promise.resolve({ ok: true, level: "MEETS_DEVICE_INTEGRITY", reason: null });
    }
    return Promise.resolve({ ok: false, level: "MEETS_BASIC_INTEGRITY", reason: "fixture_fail" });
  }
}

export async function registrationToken(pubkeyB64: string): Promise<string> {
  const der = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
  return `pass:${b64url(await sha256(der))}`;
}

export async function testToken(nonce: string | null, deviceId: string, ts: string): Promise<string> {
  return `pass:${b64url(await sha256(nonce ?? `${deviceId}|${ts}`))}`;
}

export function sim(slot: number, ok: boolean, extra: Partial<Sim> = {}): Sim {
  return {
    slot,
    mcc_mnc: "621-30",
    net_type: "LTE",
    cells: [{
      reg: true,
      radio: "LTE",
      sample: 0,
      mcc: 621,
      mnc: 30,
      area: 500,
      cid: 1001,
      pci: 12,
      rsrp: -98,
      ta: 7,
      level: 3,
    }],
    latency_ms: [120, null, 140],
    upload: ok
      ? {
        ok: true,
        bytes: 1572864,
        dns_ms: 20,
        connect_ms: 80,
        tls_ms: 150,
        ttfb_ms: 9000,
        total_ms: 18000,
        http_status: 200,
        err: null,
      }
      : {
        ok: false,
        bytes: 0,
        dns_ms: null,
        connect_ms: null,
        tls_ms: null,
        ttfb_ms: null,
        total_ms: null,
        http_status: null,
        err: "no_network",
      },
    ...extra,
  };
}

/** Most recent 19:30 WAT (18:30 UTC) at least an hour ago, minus `daysBack` days. */
export function eveningTs(daysBack = 0, plusMinutes = 0): string {
  const now = Date.now();
  const d = new Date(now);
  d.setUTCHours(18, 30, 0, 0);
  if (d.getTime() > now - 3_600_000) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return new Date(d.getTime() + plusMinutes * 60_000).toISOString().replace(".000Z", "+00:00");
}
