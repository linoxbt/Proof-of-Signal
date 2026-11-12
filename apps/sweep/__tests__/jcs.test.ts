// RFC 8785 (JCS) conformance: the examples from sections 3.2.2-3.2.4 and the Appendix B number table.
import { createHash } from "node:crypto";
import { base64Decode, base64Encode, base64UrlEncode, hex, utf8Encode } from "../src/protocol/bytes";
import { canonicalize } from "../src/protocol/jcs";
import { sha256 } from "../src/protocol/sha256";

describe("RFC 8785 JCS", () => {
  test("section 3.2.2 example: whitespace, numbers, string escapes, literals", () => {
    // Parsed from the RFC's input text, so number literals go through the JSON parser as they would on a server.
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals": [null, true, false]}',
    );
    const expected =
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    expect(canonicalize(input)).toBe(expected);
  });

  test("section 3.2.4: UTF-8 bytes of the canonical example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/",
      literals: [null, true, false],
    };
    const expectedHex = (
      "7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72" +
      " 75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a" +
      " 5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31" +
      " 65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37" +
      " 5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30" +
      " 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d"
    ).replace(/ /g, "");
    expect(hex(utf8Encode(canonicalize(input)))).toBe(expectedHex);
  });

  test("section 3.2.3: property sorting by UTF-16 code units", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    const out = canonicalize(input);
    const keys = Object.keys(JSON.parse(out));
    // JSON.parse keeps integer-like keys first; compare the serialised order instead.
    expect(keys.sort()).toEqual(Object.keys(input).sort());
    expect(out).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  test("nested objects sort recursively; arrays keep order", () => {
    expect(canonicalize({ b: [3, { z: 1, a: 2 }], a: { y: null, x: "s" } })).toBe('{"a":{"x":"s","y":null},"b":[3,{"a":2,"z":1}]}');
  });

  // Appendix B: IEEE 754 bit patterns and their required serialisation.
  const numbers: [string, string][] = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];
  test.each(numbers)("Appendix B number %s -> %s", (bits, expected) => {
    const buf = Buffer.from(bits, "hex");
    expect(canonicalize(buf.readDoubleBE(0))).toBe(expected);
  });

  test("NaN and Infinity are rejected (Appendix B 7fffffffffffffff, 7ff0000000000000)", () => {
    expect(() => canonicalize(Buffer.from("7fffffffffffffff", "hex").readDoubleBE(0))).toThrow();
    expect(() => canonicalize(Buffer.from("7ff0000000000000", "hex").readDoubleBE(0))).toThrow();
  });

  test("lone surrogates are rejected", () => {
    expect(() => canonicalize({ a: "\ud800" })).toThrow();
    expect(() => canonicalize({ "\udc00": 1 })).toThrow();
  });
});

describe("byte helpers", () => {
  test("sha256 matches node:crypto", () => {
    for (const s of ["", "abc", "n_AbCdEfGhIjKlMnOpQrStUv", "x".repeat(1000), "€😀"]) {
      expect(hex(sha256(utf8Encode(s)))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  test("utf8Encode matches Buffer", () => {
    const s = "Yorùbá Ìgbò Hausa ɗ ƙ € 😀";
    expect(Buffer.from(utf8Encode(s)).equals(Buffer.from(s, "utf8"))).toBe(true);
  });

  test("base64 round trip and url-safe form", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(base64Encode(b)).toBe(Buffer.from(b).toString("base64"));
      expect(Buffer.from(base64Decode(base64Encode(b))).equals(Buffer.from(b))).toBe(true);
      expect(base64UrlEncode(b)).toBe(Buffer.from(b).toString("base64url"));
    }
  });
});
