// RFC 8785 JSON Canonicalization Scheme.
//
// Strings and numbers use ECMAScript serialization (JSON.stringify), which is
// exactly what JCS specifies (RFC 8785 sections 3.2.2.2 and 3.2.2.3). Object
// members are sorted by their names as arrays of UTF-16 code units, which is
// JavaScript's default string comparison. No whitespace is emitted.

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(value); // -0 serializes as "0", as JCS requires
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareUtf16);
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`JCS: cannot serialize ${typeof value}`);
  }
}

function compareUtf16(a: string, b: string): number {
  // String comparison with < compares UTF-16 code units, as RFC 8785 3.2.3 requires.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
