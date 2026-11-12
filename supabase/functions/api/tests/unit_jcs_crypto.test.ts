import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { canonicalize } from "../lib/jcs.ts";
import { b64decode, b64encode, derToRaw, rawToDer, verifyEs256 } from "../lib/crypto.ts";
import { newKey, signDer } from "./helpers.ts";

Deno.test("JCS: RFC 8785 section 3.2.2 example", () => {
  const input = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  assertEquals(
    canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

Deno.test("JCS: RFC 8785 section 3.2.3 sorting by UTF-16 code units", () => {
  const input = JSON.parse(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
      '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
  );
  // Expected order from the RFC, read off the string (JS objects would
  // enumerate the integer-like key "1" first).
  const out = canonicalize(input);
  const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"];
  const pos = order.map((k) => out.indexOf(JSON.stringify(k) + ":"));
  assert(pos.every((x) => x > 0));
  assertEquals([...pos].sort((a, b) => a - b), pos);
});

Deno.test("JCS: number serialization (RFC 8785 appendix B)", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [-0, "0"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740992, "9007199254740992"],
    [295147905179352830000, "295147905179352830000"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [0.000001, "0.000001"],
    [8.4901, "8.4901"],
  ];
  for (const [n, s] of cases) assertEquals(canonicalize(n), s);
  assertThrows(() => canonicalize(NaN));
  assertThrows(() => canonicalize(Infinity));
});

Deno.test("JCS: nested objects, arrays, no whitespace, undefined members dropped", () => {
  assertEquals(
    canonicalize({ b: [1, { z: null, a: "x" }], a: { d: true, c: false }, u: undefined }),
    '{"a":{"c":false,"d":true},"b":[1,{"a":"x","z":null}]}',
  );
});

Deno.test("DER <-> raw: roundtrip and WebCrypto verification over many signatures", async () => {
  const key = await newKey();
  const data = new TextEncoder().encode("proof of signal");
  let sawPadded = false;
  let sawShort = false;
  for (let i = 0; i < 200; i++) {
    const sigB64 = await signDer(key, data);
    const der = b64decode(sigB64);
    // r or s with the high bit set needs a 0x00 pad byte (33-byte INTEGER).
    if (der[3] === 33 || der[der[3] + 5] === 33) sawPadded = true;
    if (der[3] < 32) sawShort = true;
    const raw = derToRaw(der);
    assertEquals(raw.length, 64);
    assertEquals(rawToDer(raw), der);
    assert(await verifyEs256(key.pubkey, sigB64, data));
  }
  assert(sawPadded, "expected at least one padded INTEGER in 200 signatures");
  // Short integers (leading zero byte) occur with probability ~1/128 per value; not asserted.
  void sawShort;
});

Deno.test("DER: short integers are left-padded", () => {
  const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]);
  const raw = derToRaw(der);
  assertEquals(raw[31], 5);
  assertEquals(raw[63], 7);
  assertEquals(raw.slice(0, 31).every((b) => b === 0), true);
});

Deno.test("DER: malformed signatures are rejected", () => {
  const bad = [
    new Uint8Array([]),
    new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]), // not a SEQUENCE
    new Uint8Array([0x30, 0x07, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]), // length mismatch
    new Uint8Array([0x30, 0x07, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07, 0x00]), // trailing byte inside
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x85, 0x02, 0x01, 0x07]), // negative r
    new Uint8Array([0x30, 0x07, 0x02, 0x02, 0x00, 0x05, 0x02, 0x01, 0x07]), // non-minimal r
    new Uint8Array([0x30, 0x26, 0x02, 0x21, ...new Array(33).fill(1), 0x02, 0x01, 0x07]), // r too wide
  ];
  for (const d of bad) assertThrows(() => derToRaw(d));
});

Deno.test("ES256: wrong data, wrong key and garbage inputs do not verify", async () => {
  const a = await newKey();
  const b = await newKey();
  const data = new TextEncoder().encode("payload");
  const sig = await signDer(a, data);
  assert(await verifyEs256(a.pubkey, sig, data));
  assertFalse(await verifyEs256(a.pubkey, sig, new TextEncoder().encode("payloaD")));
  assertFalse(await verifyEs256(b.pubkey, sig, data));
  assertFalse(await verifyEs256("not-base64!", sig, data));
  assertFalse(await verifyEs256(a.pubkey, "AAAA", data));
  // Raw r||s instead of DER is not accepted.
  const raw = derToRaw(b64decode(sig));
  assertFalse(await verifyEs256(a.pubkey, b64encode(raw), data));
});
