// JSON Schema validation of the POST /v1/tests payload, plus the rules the
// schema cannot express. The validator is an Ajv standalone module generated
// at build time (`deno task gen-schema`) from schema/test-payload.schema.json,
// a copy of contracts/test-payload.schema.json; unit tests fail if either is
// stale. No code is compiled at runtime.

import validate from "./validate_payload.generated.js";

export interface Cell {
  reg: boolean;
  radio: "GSM" | "WCDMA" | "UMTS" | "LTE" | "NR" | "CDMA";
  sample: number;
  mcc?: number | null;
  mnc?: number | null;
  area?: number | null;
  cid?: number | null;
  pci?: number | null;
  earfcn?: number | null;
  rsrp?: number | null;
  rsrq?: number | null;
  rssnr?: number | null;
  rssi?: number | null;
  ta?: number | null;
  level?: number | null;
}

export interface Sim {
  slot: number;
  mcc_mnc: string;
  net_type: string | null;
  cells: Cell[];
  latency_ms: (number | null)[];
  upload: {
    ok: boolean;
    bytes: number;
    dns_ms: number | null;
    connect_ms: number | null;
    tls_ms: number | null;
    ttfb_ms: number | null;
    total_ms: number | null;
    http_status: number | null;
    err: string | null;
  };
}

export interface Payload {
  v: 1;
  device_id: string;
  nonce: string | null;
  pu_code: string;
  ts: string;
  fix: { lat: number; lng: number; acc_m: number; mock: boolean };
  sims: Sim[];
  app: string;
  integrity: string;
  sig: string;
}

/** Returns null when valid, else a human-readable reason. */
export function validatePayload(p: unknown): string | null {
  if (!validate(p)) {
    const e = validate.errors?.[0];
    return e ? `${e.instancePath || "/"} ${e.message}` : "payload does not match the schema";
  }
  const payload = p as Payload;
  const slots = new Set<number>();
  for (const s of payload.sims) {
    if (slots.has(s.slot)) return `/sims duplicate slot ${s.slot}`;
    slots.add(s.slot);
  }
  if (payload.nonce === null && payload.sims.some((s) => s.upload.ok)) {
    return "/nonce is null but an upload claims ok (offline runs cannot pass)";
  }
  if (!Number.isFinite(Date.parse(payload.ts))) return "/ts is not a valid date-time";
  return null;
}

/** Android reports WCDMA; the database (OpenCellID naming) stores UMTS. */
export function dbRadio(r: Cell["radio"]): "GSM" | "UMTS" | "LTE" | "NR" | "CDMA" {
  return r === "WCDMA" ? "UMTS" : r;
}

export function parseMccMnc(s: string): { mcc: number; mnc: number } {
  const [mcc, mnc] = s.split("-");
  return { mcc: Number(mcc), mnc: Number(mnc) };
}
