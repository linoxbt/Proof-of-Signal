// Interfaces between the protocol (plain TypeScript, unit-tested) and the platform (pos-radio, expo-location,
// fetch, expo-sqlite). The app wires real adapters in src/native; tests wire fakes.

import type { NearbyUnit, TestPayload, TestResponse, UploadResult } from "../contracts";

/** One active subscription (SIM) as SubscriptionManager reports it. */
export interface SimInfo {
  slot: number; // SIM slot index 0..3
  subId: number; // Android subscription id; -1 when unknown
  mcc: string | null; // "621"
  mnc: string | null; // "30"
  carrier: string | null;
}

/** A cell as the native module reports it; unavailable values are null. */
export interface RawCell {
  radio: "GSM" | "WCDMA" | "LTE" | "NR" | "CDMA";
  reg: boolean;
  mcc: number | null;
  mnc: number | null;
  area: number | null;
  cid: number | null;
  pci: number | null;
  earfcn: number | null;
  rsrp: number | null;
  rsrq: number | null;
  rssnr: number | null;
  rssi: number | null;
  ta: number | null;
  level: number | null;
}

export interface SimSnapshot {
  slot: number;
  subId: number;
  netType: string | null; // data network type, e.g. "LTE", "NR", "HSPA"
  cells: RawCell[];
}

export interface HeadResult {
  ms: number | null; // round trip; null when it failed
  status: number | null;
  err: string | null;
}

export interface BindResult {
  handle: number | null; // opaque network handle, valid until release()
  err: string | null; // e.g. "sim_unbindable", "permission"
}

export interface RadioPort {
  subscriptions(): Promise<SimInfo[]>;
  snapshot(): Promise<SimSnapshot[]>;
  /** ConnectivityManager.requestNetwork(TRANSPORT_CELLULAR + INTERNET) for this subscription. */
  bindCellular(subId: number, timeoutMs: number): Promise<BindResult>;
  releaseCellular(handle: number): Promise<void>;
  /** One HEAD through the bound network. Never throws for network failure. */
  headProbe(handle: number, url: string, timeoutMs: number): Promise<HeadResult>;
  /** One PUT of a synthetic JPEG of `size` bytes through the bound network. Never throws for network failure. */
  uploadProbe(handle: number, url: string, size: number, nonce: string, timeoutMs: number): Promise<UploadResult>;
  /** Location.isMock (API 31+) / isFromMockProvider of the newest fix the platform holds; null if none. */
  isMockLocation(): Promise<boolean | null>;
}

export interface KeyPort {
  /** Create the Keystore EC P-256 key if absent (with an attestation challenge when supported). */
  ensureKey(): Promise<void>;
  /** base64 (standard, padded) SPKI DER. */
  publicKey(): Promise<string>;
  /** SHA256withECDSA over the given bytes (base64 in), DER signature (base64 out). */
  sign(dataB64: string): Promise<string>;
}

export interface IntegrityPort {
  /** Play Integrity standard request token for a base64url request hash. Must not throw: errors become a marker. */
  token(requestHash: string): Promise<string>;
}

export interface Fix {
  lat: number;
  lng: number;
  accM: number;
  mocked: boolean | null; // platform's mock flag for this fix, if it reports one
  time: number; // epoch ms
}

export interface LocationPort {
  /** Best fix reaching `maxAccM` within `timeoutMs`, or the best seen so far, or null. */
  getFix(maxAccM: number, timeoutMs: number): Promise<Fix | null>;
}

export interface NonceResponse {
  nonce: string;
  expires_at: string;
}

export interface ApiPort {
  registerDevice(body: { pubkey: string; integrity_token: string; app_version: string }): Promise<{
    device_id: string;
    status: string;
    integrity_level: string;
  }>;
  nonce(deviceId: string): Promise<NonceResponse>;
  submitTest(payload: TestPayload): Promise<TestResponse>;
  eraseDeviceData(deviceId: string, body: { ts: string; sig: string }): Promise<{ tests_deleted: number }>;
  nearby(lat: number, lng: number, radiusM: number, limit: number): Promise<NearbyUnit[]>;
  search(q: string, limit: number): Promise<NearbyUnit[]>;
}

export interface NetPort {
  isOnline(): Promise<boolean>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
