// Shared types for contracts/api.md. Type-only: import with `import type`.

export type RadioType = "GSM" | "WCDMA" | "UMTS" | "LTE" | "NR" | "CDMA";

export interface CellObservation {
  reg: boolean;            // registered (serving) cell
  radio: RadioType;        // app sends Android names; API stores WCDMA as UMTS
  sample: number;          // snapshot index 0..4
  mcc?: number | null;
  mnc?: number | null;
  area?: number | null;    // TAC (LTE/NR) or LAC (GSM/WCDMA)
  cid?: number | null;
  pci?: number | null;
  earfcn?: number | null;
  rsrp?: number | null;
  rsrq?: number | null;
  rssnr?: number | null;
  rssi?: number | null;
  ta?: number | null;
  level?: number | null;   // 0..4
}

export interface UploadResult {
  ok: boolean;
  bytes: number;           // bytes sent
  dns_ms: number | null;
  connect_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number | null;
  http_status: number | null;
  err: string | null;      // error class, e.g. "timeout", "no_network", "dns"
}

export interface SimResult {
  slot: number;            // 0..3
  mcc_mnc: string;         // "621-30"
  net_type: string | null; // "LTE", "NR", "HSPA", ...
  cells: CellObservation[];
  latency_ms: (number | null)[]; // 3 HEAD round trips; null = failed
  upload: UploadResult;
}

export interface TestPayload {
  v: 1;
  device_id: string;
  nonce: string | null;    // null only for offline runs where every upload.ok is false
  pu_code: string;
  ts: string;              // RFC 3339 with offset, e.g. 2026-12-02T19:14:05+01:00
  fix: { lat: number; lng: number; acc_m: number; mock: boolean };
  sims: SimResult[];
  app: string;             // app version
  integrity: string;       // Play Integrity token, request hash = base64url(sha256(nonce)) or, offline, base64url(sha256(device_id + "|" + ts))
  sig: string;             // base64 DER ECDSA over JCS(payload without sig)
}

export interface Progress {
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  measured: boolean;
  needed: number;
}

export interface NearbyUnit {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  lat: number | null;
  lng: number | null;
  geom_source: "inec" | "crediblevote" | "crowd" | null;
  dist_m?: number;
  progress: Progress;
}

export interface TestResponse {
  test_id: string;
  status: "accepted" | "quarantined" | "rejected";
  reject_reason: string | null;
  trust: number;
  progress: Progress;
}

export interface CarrierCoverage {
  mcc: number;
  mnc: number;
  carrier: string | null;
  p: number;
  p_lo: number;
  p_hi: number;
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  measured: boolean;
}

export interface CoverageResponse {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  lat: number | null;
  lng: number | null;
  model_version: string | null;
  best: { p: number; p_lo: number; p_hi: number; measured: boolean; n_tests: number } | null;
  carriers: CarrierCoverage[];
}

export interface RegisterRow {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  p_best: number;
  p_lo: number;
  p_hi: number;
  n_tests: number;
  carriers_seen: string;
  suggested_action: string;
}

export interface NightSummary {
  election_id: string;
  polls_close_at: string;
  minutes_since_close: number;
  system_stall: { active: boolean; since: string | null; banner: string | null };
  totals: { units: number; uploaded: number; pending: number; cancelled: number };
  states: { state_code: number; state: string; units: number; uploaded: number; pending: number; cancelled: number }[];
  updated_at: string;
}

export type PublicBucket =
  | "uploaded"
  | "pending"
  | "network_failure_plausible"
  | "needs_review"
  | "not_enough_tests"
  | "held_system_stall";

export type FlagClass = "HELD_SYSTEM_STALL" | "NOT_MEASURED" | "PLAUSIBLE_NETWORK" | "UNEXPLAINED_DELAY" | "WATCH";
export type ReviewStatus = "unreviewed" | "awaiting_second" | "concern_confirmed" | "explained" | "dismissed";
export type ReviewDecision = "concern_confirmed" | "explained" | "dismissed";

export interface Evidence {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  snapshot_id: string;
  snapshot_sha256: string;
  measured: boolean;
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  carriers: { mnc: number; carrier: string | null; p: number; p_lo: number; p_hi: number }[];
  p_best: number;
  p_best_lo: number;
  p_best_hi: number;
  neighbours: { pu_code: string; name: string; dist_m: number | null; uploaded_at: string; shared: "ward" | "cell" }[];
  neighbours_uploaded: number;
  minutes_since_close: number;
  minutes_pending: number;
  s_t: number;
  p_network: number;
  p_other: number;
  p_delay: number;
  caveat: string;
}

export interface Flag {
  id: string;
  pu_code: string;
  class: FlagClass;
  p_network: number | null;
  p_other: number | null;
  review_status: ReviewStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  evidence: Evidence;
  reviews: { reviewer_id: string; decision: ReviewDecision; note: string | null; created_at: string }[];
}

export interface ApiError {
  error: { code: string; message: string };
}
