import type { TestPayload } from "../contracts";
import { base64Encode, base64UrlEncode, hex, utf8Encode } from "./bytes";
import { canonicalize } from "./jcs";
import type { IntegrityPort, KeyPort } from "./ports";
import { sha256 } from "./sha256";

export type UnsealedPayload = Omit<TestPayload, "integrity" | "sig">;

/** UTF-8 of JCS(payload without `sig`): exactly the bytes the device signs and the API verifies. */
export function signedBytes(p: Omit<TestPayload, "sig"> | TestPayload): Uint8Array {
  const { sig: _sig, ...rest } = p as TestPayload;
  return utf8Encode(canonicalize(rest));
}

/** `payload_sha256` as the API stores it: SHA-256 of the canonical JSON of the full payload, `sig` included. */
export function payloadSha256Hex(p: TestPayload): string {
  return hex(sha256(utf8Encode(canonicalize(p))));
}

/**
 * Play Integrity request hash for a test (contracts/api.md): base64url(sha256(nonce)) online,
 * base64url(sha256(device_id + "|" + ts)) for an offline run.
 */
export function testRequestHash(p: { nonce: string | null; device_id: string; ts: string }): string {
  const input = p.nonce != null ? p.nonce : `${p.device_id}|${p.ts}`;
  return base64UrlEncode(sha256(utf8Encode(input)));
}

/** Registration request hash: base64url(sha256(pubkey DER bytes)). */
export function registrationRequestHash(pubkeyDer: Uint8Array): string {
  return base64UrlEncode(sha256(pubkeyDer));
}

/**
 * Attach the integrity token, then sign. The order matters: the token is part of the signed bytes, so it is
 * requested first, and `sig` is the only member added after signing.
 */
export async function sealPayload(p: UnsealedPayload, integrity: IntegrityPort, keys: KeyPort): Promise<TestPayload> {
  const token = await integrity.token(testRequestHash(p));
  const withToken: Omit<TestPayload, "sig"> = { ...p, integrity: token };
  const sig = await keys.sign(base64Encode(signedBytes(withToken)));
  return { ...withToken, sig };
}

/** Body for DELETE /v1/devices/{id}/data: sig over JCS of {device_id, op: "erase", ts}. */
export async function signErase(deviceId: string, ts: string, keys: KeyPort): Promise<{ ts: string; sig: string }> {
  const bytes = utf8Encode(canonicalize({ device_id: deviceId, op: "erase", ts }));
  return { ts, sig: await keys.sign(base64Encode(bytes)) };
}
