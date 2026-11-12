// RFC 8785 JSON Canonicalization Scheme.
//
// - Object members sorted by their names as arrays of UTF-16 code units (plain JS string comparison).
// - Numbers serialised as ECMAScript Number.prototype.toString does (RFC 8785 section 3.2.2.3); -0 becomes 0;
//   NaN and Infinity are not JSON and are rejected.
// - Strings serialised as ECMAScript JSON.stringify does (section 3.2.2.2). Lone surrogates are rejected
//   because they cannot be encoded as UTF-8 (section 3.2.1 requires I-JSON input).
// - Members whose value is `undefined` are omitted, as JSON.stringify would.

export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("JCS: non-finite number");
      return Object.is(v, -0) ? "0" : String(v);
    case "string":
      assertWellFormed(v);
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return "[" + v.map((x) => (x === undefined ? "null" : serialize(x))).join(",") + "]";
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareUtf16);
      return "{" + keys.map((k) => (assertWellFormed(k), JSON.stringify(k) + ":" + serialize(obj[k]))).join(",") + "}";
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof v}`);
  }
}

function compareUtf16(a: string, b: string): number {
  // JS relational comparison on strings is by UTF-16 code units, exactly what RFC 8785 section 3.2.3 requires.
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertWellFormed(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error("JCS: lone surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error("JCS: lone surrogate");
    }
  }
}
