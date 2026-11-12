// Fake radio, network, keys, integrity and API for protocol tests. Keys are a real P-256 pair from Node's
// crypto, so signatures are verified for real.
import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { NearbyUnit, TestPayload, TestResponse, UploadResult } from "../../src/contracts";
import { ApiError, NetworkError } from "../../src/protocol/api";
import type {
  ApiPort,
  Clock,
  Fix,
  HeadResult,
  IntegrityPort,
  KeyPort,
  LocationPort,
  NetPort,
  RadioPort,
  RawCell,
  SimInfo,
  SimSnapshot,
} from "../../src/protocol/ports";
import { payloadSha256Hex } from "../../src/protocol/sign";

export const DEVICE_ID = "6f1c2a52-7d1e-4a59-9c1e-2f0b7b1d9a10";
export const NONCE = "n_AbCdEfGhIjKlMnOpQrStUv";
export const UNIT = { pu_code: "99-01-01-001", lat: 8.49, lng: 4.55 };

/** Shared call log so tests can assert ordering across fakes. */
export type CallLog = string[];

export function lteCell(over: Partial<RawCell> = {}): RawCell {
  return {
    radio: "LTE",
    reg: true,
    mcc: 621,
    mnc: 30,
    area: 12345,
    cid: 98765432,
    pci: 301,
    earfcn: 1650,
    rsrp: -95,
    rsrq: -11,
    rssnr: 8,
    rssi: -65,
    ta: 3,
    level: 3,
    ...over,
  };
}

export function wcdmaCell(over: Partial<RawCell> = {}): RawCell {
  return {
    radio: "WCDMA",
    reg: true,
    mcc: 621,
    mnc: 20,
    area: 501,
    cid: 268435000,
    pci: 120,
    earfcn: 10812,
    rsrp: -88,
    rsrq: -9,
    rssnr: null,
    rssi: null,
    ta: null,
    level: 2,
    ...over,
  };
}

export const okUpload = (over: Partial<UploadResult> = {}): UploadResult => ({
  ok: true,
  bytes: 1572864,
  dns_ms: 40,
  connect_ms: 120,
  tls_ms: 180,
  ttfb_ms: 300,
  total_ms: 9100,
  http_status: 200,
  err: null,
  ...over,
});

export class FakeRadio implements RadioPort {
  sims: SimInfo[] = [
    { slot: 0, subId: 1, mcc: "621", mnc: "30", carrier: "MTN" },
    { slot: 1, subId: 2, mcc: "621", mnc: "20", carrier: "Airtel" },
  ];
  cellsBySlot: Record<number, RawCell[]> = {
    0: [lteCell(), lteCell({ reg: false, cid: null, pci: 77, rsrp: -110, level: 1, ta: null })],
    1: [wcdmaCell()],
  };
  netTypeBySlot: Record<number, string | null> = { 0: "LTE", 1: "HSPA" };
  uploads: UploadResult[] = []; // queued results; okUpload() when empty
  bindErrBySub: Record<number, string> = {};
  mock: boolean | null = false;
  readonly heads: string[] = [];
  readonly uploadUrls: string[] = [];
  readonly released: number[] = [];

  constructor(private readonly log: CallLog = []) {}

  async subscriptions() {
    return this.sims;
  }
  async snapshot(): Promise<SimSnapshot[]> {
    this.log.push("snapshot");
    return this.sims.map((s) => ({ slot: s.slot, subId: s.subId, netType: this.netTypeBySlot[s.slot] ?? null, cells: this.cellsBySlot[s.slot] ?? [] }));
  }
  async bindCellular(subId: number) {
    this.log.push(`bind:${subId}`);
    const err = this.bindErrBySub[subId];
    return err ? { handle: null, err } : { handle: 1000 + subId, err: null };
  }
  async releaseCellular(h: number) {
    this.released.push(h);
  }
  async headProbe(_h: number, url: string): Promise<HeadResult> {
    this.log.push("head");
    this.heads.push(url);
    return { ms: 85, status: 204, err: null };
  }
  async uploadProbe(_h: number, url: string, size: number): Promise<UploadResult> {
    this.log.push(`upload:${size}`);
    this.uploadUrls.push(url);
    return this.uploads.shift() ?? okUpload();
  }
  async isMockLocation() {
    return this.mock;
  }
}

export class FakeKeys implements KeyPort {
  readonly privateKey: KeyObject;
  readonly publicKeyObj: KeyObject;
  readonly signed: Buffer[] = [];
  constructor(private readonly log: CallLog = []) {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    this.publicKeyObj = kp.publicKey;
  }
  async ensureKey() {
    this.log.push("ensureKey");
  }
  async publicKey() {
    return (this.publicKeyObj.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  }
  async sign(dataB64: string) {
    this.log.push("sign");
    const data = Buffer.from(dataB64, "base64");
    this.signed.push(data);
    return nodeSign("sha256", data, { key: this.privateKey, dsaEncoding: "der" }).toString("base64");
  }
}

/** Verify like the API: SPKI public key, DER signature over the given bytes. */
export function verifySig(pubkeyB64: string, data: Uint8Array, sigB64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
  return nodeVerify("sha256", Buffer.from(data), { key, dsaEncoding: "der" }, Buffer.from(sigB64, "base64"));
}

export class FakeIntegrity implements IntegrityPort {
  readonly hashes: string[] = [];
  constructor(private readonly log: CallLog = []) {}
  async token(hash: string) {
    this.log.push("integrity");
    this.hashes.push(hash);
    return `itok.${hash}`;
  }
}

export class FakeLocation implements LocationPort {
  fix: Fix | null = { lat: 8.4905, lng: 4.5503, accM: 12.34, mocked: false, time: 0 };
  async getFix() {
    return this.fix;
  }
}

export class FakeNet implements NetPort {
  online = true;
  async isOnline() {
    return this.online;
  }
}

export class FakeClock implements Clock {
  t = Date.parse("2026-12-02T18:14:05Z");
  readonly sleeps: number[] = [];
  now() {
    return new Date(this.t);
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

const progress = { n_tests: 1, n_devices: 1, n_evenings: 1, measured: false, needed: 2 };

/** API fake that dedupes POST /v1/tests by payload_sha256, like the real one. */
export class FakeApi implements ApiPort {
  online = true;
  nonceValue = NONCE;
  nonceTtlMs = 5 * 60_000;
  nonceError: ApiError | null = null;
  submitError: ApiError | null = null;
  readonly posts: TestPayload[] = [];
  readonly stored = new Map<string, TestResponse>();
  readonly erases: { id: string; body: { ts: string; sig: string } }[] = [];
  constructor(private readonly clock: Clock = new FakeClock()) {}

  private ensureOnline() {
    if (!this.online) throw new NetworkError("Network request failed");
  }
  async registerDevice() {
    this.ensureOnline();
    return { device_id: DEVICE_ID, status: "active", integrity_level: "UNVERIFIED" };
  }
  async nonce() {
    this.ensureOnline();
    if (this.nonceError) throw this.nonceError;
    return { nonce: this.nonceValue, expires_at: new Date(this.clock.now().getTime() + this.nonceTtlMs).toISOString() };
  }
  async submitTest(p: TestPayload) {
    this.ensureOnline();
    this.posts.push(p);
    if (this.submitError) throw this.submitError;
    const sha = payloadSha256Hex(p);
    const prev = this.stored.get(sha);
    if (prev) return prev;
    const res: TestResponse = { test_id: `t-${this.stored.size + 1}`, status: "accepted", reject_reason: null, trust: 0.5, progress };
    this.stored.set(sha, res);
    return res;
  }
  async eraseDeviceData(id: string, body: { ts: string; sig: string }) {
    this.ensureOnline();
    this.erases.push({ id, body });
    return { tests_deleted: this.stored.size };
  }
  async nearby(): Promise<NearbyUnit[]> {
    return [];
  }
  async search(): Promise<NearbyUnit[]> {
    return [];
  }
}

let validator: ReturnType<Ajv2020["compile"]> | null = null;

/** contracts/test-payload.schema.json compiled with Ajv (draft 2020-12, uuid + date-time formats). */
export function validatePayload(p: unknown): { valid: boolean; errors: unknown } {
  if (!validator) {
    const schema = JSON.parse(readFileSync(join(__dirname, "../../../../contracts/test-payload.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    validator = ajv.compile(schema);
  }
  const valid = validator(p) as boolean;
  return { valid, errors: validator.errors };
}
