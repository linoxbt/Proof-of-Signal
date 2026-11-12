// JS face of the Kotlin module (android/src/main/java/ng/proofofsignal/posradio). Android only.
import { requireOptionalNativeModule } from "expo";

export interface NativeSub {
  slot: number;
  subId: number;
  mcc: string | null;
  mnc: string | null;
  carrier: string | null;
}

export interface NativeCell {
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

export interface NativeSimSnapshot {
  slot: number;
  subId: number;
  netType: string | null;
  cells: NativeCell[];
}

export interface NativeUpload {
  ok: boolean;
  bytes: number;
  dns_ms: number | null;
  connect_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number | null;
  http_status: number | null;
  err: string | null;
}

export interface PosRadioNativeModule {
  subscriptions(): Promise<NativeSub[]>;
  snapshot(): Promise<NativeSimSnapshot[]>;
  bindCellular(subId: number, timeoutMs: number): Promise<{ handle: number | null; err: string | null }>;
  releaseCellular(handle: number): Promise<void>;
  headProbe(handle: number, url: string, timeoutMs: number): Promise<{ ms: number | null; status: number | null; err: string | null }>;
  uploadProbe(handle: number, url: string, size: number, nonce: string, timeoutMs: number): Promise<NativeUpload>;
  isMockLocation(): Promise<boolean | null>;
  ensureKey(attestationChallengeB64: string | null): Promise<{ created: boolean; strongBox: boolean; attested: boolean }>;
  getPublicKey(): Promise<string>;
  sign(dataB64: string): Promise<string>;
  attestationChain(): Promise<string[]>;
  /** cloudProjectNumber as a decimal string; "" means dev build without Play Integrity (returns a marker). */
  integrityToken(cloudProjectNumber: string, requestHash: string): Promise<string>;
}

/** null outside a dev/prod build that includes the module (Expo Go, web, jest). */
export const PosRadio = requireOptionalNativeModule<PosRadioNativeModule>("PosRadio");
