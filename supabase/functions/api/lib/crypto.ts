// Base64 helpers, SHA-256, DER ECDSA signature conversion and ES256 verify.

export function b64decode(s: string): Uint8Array {
  // Standard alphabet, padded (the contract's encoding). Reject anything else.
  if (typeof s !== "string" || s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw new Error("not standard padded base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(std + "=".repeat((4 - (std.length % 4)) % 4));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/**
 * Converts a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }), as
 * Android's Signature.sign() returns it, to the raw r||s form WebCrypto
 * expects. Strict: rejects trailing bytes, long-form lengths that are not
 * needed, negative integers and values wider than the curve.
 */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const fail = (m: string): never => {
    throw new Error(`bad DER signature: ${m}`);
  };
  if (der[i++] !== 0x30) fail("expected SEQUENCE");
  let seqLen = der[i++];
  if (seqLen === undefined) fail("truncated");
  if (seqLen & 0x80) {
    if (seqLen !== 0x81) fail("unsupported length form");
    seqLen = der[i++];
    if (seqLen < 0x80) fail("non-minimal length");
  }
  if (i + seqLen !== der.length) fail("length mismatch");
  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) fail("expected INTEGER");
    const len = der[i++];
    if (!len || len & 0x80) fail("bad INTEGER length");
    if (i + len > der.length) fail("truncated INTEGER");
    let v = der.subarray(i, i + len);
    i += len;
    if (v[0] & 0x80) fail("negative INTEGER");
    if (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) fail("non-minimal INTEGER");
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail("INTEGER too large");
    return v;
  };
  const r = readInt();
  const s = readInt();
  if (i !== der.length) fail("trailing bytes");
  const out = new Uint8Array(size * 2);
  out.set(r, size - r.length);
  out.set(s, size * 2 - s.length);
  return out;
}

/** Raw r||s to DER (used by tests and tooling to mimic Android). */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const enc = (v: Uint8Array): number[] => {
    let j = 0;
    while (j < v.length - 1 && v[j] === 0) j++;
    const body = Array.from(v.subarray(j));
    if (body[0] & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = enc(raw.subarray(0, half));
  const s = enc(raw.subarray(half));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export async function importSpkiP256(spki: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    spki as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

/** Verifies a base64 DER ES256 signature over `data` with a base64 SPKI key. False on any malformed input. */
export async function verifyEs256(pubkeyB64: string, sigB64: string, data: Uint8Array): Promise<boolean> {
  try {
    const key = await importSpkiP256(b64decode(pubkeyB64));
    const raw = derToRaw(b64decode(sigB64));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw as BufferSource,
      data as BufferSource,
    );
  } catch {
    return false;
  }
}

export function randomToken(nBytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
