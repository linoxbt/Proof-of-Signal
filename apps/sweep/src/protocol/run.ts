// One test run as an explicit state machine. Every platform call goes through the ports, so the whole protocol
// runs under jest with a fake radio and network.

import type { SimResult, TestPayload, UploadResult } from "../contracts";
import { ApiError, NetworkError } from "./api";
import { SAMPLES, toObservations } from "./cells";
import { MAX_ACCURACY_M, checkPlace, type PlaceCheck } from "./geo";
import type { ApiPort, Clock, IntegrityPort, KeyPort, LocationPort, NetPort, RadioPort, SimInfo, SimSnapshot } from "./ports";
import { sealPayload, type UnsealedPayload } from "./sign";
import { rfc3339Local } from "./time";

export const UPLOAD_BYTES = 1_572_864;

export type Phase =
  | "idle"
  | "locating"
  | "place_check"
  | "sampling"
  | "nonce"
  | "latency"
  | "upload"
  | "sealing"
  | "submitting"
  | "done"
  | "aborted";

/** Allowed transitions. Anything else is a programming error and throws. */
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  idle: ["locating", "aborted"],
  locating: ["place_check", "aborted"],
  place_check: ["sampling", "aborted"],
  sampling: ["nonce", "aborted"],
  nonce: ["latency", "upload", "sealing", "aborted"], // offline runs go straight to sealing
  latency: ["upload", "aborted"],
  upload: ["latency", "upload", "sealing", "aborted"], // next SIM, or done with SIMs
  sealing: ["submitting", "aborted"],
  submitting: ["done", "aborted"],
  done: [],
  aborted: [],
};

export type AbortReason =
  | "no_fix"
  | "low_accuracy"
  | "mock_location"
  | "outside_nigeria"
  | "too_far"
  | "no_sims"
  | "api_error"
  | "cancelled";

export interface RunEvent {
  phase: Phase;
  progress: number; // 0..1 for the progress ring
  sim?: { index: number; count: number; slot: number };
  sample?: number;
  accM?: number;
}

export type SubmitOutcome =
  | { state: "synced"; response: import("../contracts").TestResponse }
  | { state: "pending"; error: string | null }
  | { state: "failed"; code: string; message: string };

export type RunOutcome =
  | {
      kind: "completed";
      payload: TestPayload;
      offline: boolean;
      place: PlaceCheck;
      submit: SubmitOutcome;
    }
  | { kind: "aborted"; reason: AbortReason; detail?: string; distanceM?: number; accM?: number };

export interface RunInput {
  deviceId: string;
  unit: { pu_code: string; lat: number | null; lng: number | null };
  appVersion: string;
  probeBase: string;
}

export interface RunDeps {
  radio: RadioPort;
  keys: KeyPort;
  integrity: IntegrityPort;
  location: LocationPort;
  api: ApiPort;
  net: NetPort;
  clock: Clock;
  /** Persist the sealed payload, then try to send it (queue + sync). */
  submit(payload: TestPayload): Promise<SubmitOutcome>;
}

export interface RunOptions {
  fixTimeoutMs: number;
  samples: number;
  sampleIntervalMs: number;
  heads: number;
  headTimeoutMs: number;
  bindTimeoutMs: number;
  uploadTimeoutMs: number;
  retryDelayMs: number;
  uploadBytes: number;
}

export const DEFAULT_OPTIONS: RunOptions = {
  fixTimeoutMs: 90_000,
  samples: SAMPLES,
  sampleIntervalMs: 2_000,
  heads: 3,
  headTimeoutMs: 15_000,
  bindTimeoutMs: 20_000,
  uploadTimeoutMs: 120_000,
  retryDelayMs: 15_000,
  uploadBytes: UPLOAD_BYTES,
};

// Nigeria bounding box from the payload schema.
const LAT_RANGE = [3.0, 14.5] as const;
const LNG_RANGE = [2.5, 15.0] as const;

/** Errors worth one retry: transport failures and server errors. 4xx from the probe (409, 410, 413) are final. */
const RETRYABLE_ERRS = new Set(["timeout", "dns", "connect", "tls", "io", "reset"]);

export function isRetryable(u: UploadResult): boolean {
  if (u.ok) return false;
  if (u.http_status != null) return u.http_status >= 500;
  return u.err != null && RETRYABLE_ERRS.has(u.err);
}

export function offlineUpload(err: string): UploadResult {
  return { ok: false, bytes: 0, dns_ms: null, connect_ms: null, tls_ms: null, ttfb_ms: null, total_ms: null, http_status: null, err };
}

export function formatMccMnc(mcc: string | number | null | undefined, mnc: string | number | null | undefined): string | null {
  if (mcc == null || mnc == null) return null;
  const a = String(mcc).trim();
  const b = String(mnc).trim();
  if (!/^\d{1,3}$/.test(a) || !/^\d{1,3}$/.test(b)) return null;
  // MNC strings from SubscriptionManager keep their leading zero; integers from older APIs lose it.
  return `${a.padStart(3, "0")}-${b.length === 1 ? b.padStart(2, "0") : b}`;
}

export class TestRun {
  private phase: Phase = "idle";
  private cancelled = false;
  private readonly opts: RunOptions;

  constructor(
    private readonly deps: RunDeps,
    private readonly input: RunInput,
    private readonly onEvent: (e: RunEvent) => void = () => {},
    opts: Partial<RunOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get current(): Phase {
    return this.phase;
  }

  /** Stop at the next step boundary. An upload already in flight finishes (it cannot be interrupted cleanly). */
  cancel(): void {
    this.cancelled = true;
  }

  private go(next: Phase, e: Omit<RunEvent, "phase"> & { progress: number }): void {
    if (!TRANSITIONS[this.phase].includes(next) && !(next === this.phase && next !== "idle")) {
      throw new Error(`invalid transition ${this.phase} -> ${next}`);
    }
    this.phase = next;
    this.onEvent({ ...e, phase: next });
  }

  private abort(reason: AbortReason, extra: Omit<Extract<RunOutcome, { kind: "aborted" }>, "kind" | "reason"> = {}): RunOutcome {
    this.go("aborted", { progress: 0 });
    return { kind: "aborted", reason, ...extra };
  }

  async run(): Promise<RunOutcome> {
    const { deps, input, opts } = this;
    if (this.phase !== "idle") throw new Error("a TestRun runs once");

    // 1. Location fix: <= 30 m, not mocked.
    this.go("locating", { progress: 0.02 });
    const fix = await deps.location.getFix(MAX_ACCURACY_M, opts.fixTimeoutMs);
    if (this.cancelled) return this.abort("cancelled");
    if (!fix) return this.abort("no_fix");
    const platformMock = await deps.radio.isMockLocation().catch(() => null);
    if (fix.mocked === true || platformMock === true) return this.abort("mock_location");
    if (fix.accM > MAX_ACCURACY_M) return this.abort("low_accuracy", { accM: fix.accM });
    if (fix.lat < LAT_RANGE[0] || fix.lat > LAT_RANGE[1] || fix.lng < LNG_RANGE[0] || fix.lng > LNG_RANGE[1]) {
      return this.abort("outside_nigeria");
    }
    const ts = rfc3339Local(deps.clock.now());

    // 2. Place: within 150 m of the unit's point, or a location vote when it has none.
    this.go("place_check", { progress: 0.12, accM: fix.accM });
    const place = checkPlace(fix, input.unit);
    if (place.kind === "too_far") return this.abort("too_far", { distanceM: Math.round(place.distanceM) });

    // 3. Radio: 5 snapshots, 2 s apart, every active SIM.
    const sims = await deps.radio.subscriptions().catch(() => [] as SimInfo[]);
    const samples: SimSnapshot[][] = [];
    for (let i = 0; i < opts.samples; i++) {
      if (this.cancelled) return this.abort("cancelled");
      this.go("sampling", { progress: 0.15 + (0.2 * i) / opts.samples, sample: i });
      samples.push(await deps.radio.snapshot().catch(() => [] as SimSnapshot[]));
      if (i < opts.samples - 1) await deps.clock.sleep(opts.sampleIntervalMs);
    }
    const simList = mergeSims(sims, samples).filter((s) => s.slot >= 0 && s.slot <= 3).slice(0, 4);
    if (simList.length === 0) return this.abort("no_sims");

    // 4. Nonce, or an offline run when there is no connection.
    this.go("nonce", { progress: 0.36 });
    let nonce: string | null = null;
    let nonceExpiresAt = 0;
    if (await deps.net.isOnline().catch(() => false)) {
      try {
        const n = await deps.api.nonce(input.deviceId);
        nonce = n.nonce;
        nonceExpiresAt = Date.parse(n.expires_at) || deps.clock.now().getTime() + 5 * 60_000;
      } catch (e) {
        if (e instanceof ApiError) return this.abort("api_error", { detail: e.code });
        if (!(e instanceof NetworkError)) throw e;
      }
    }
    const offline = nonce == null;

    // 5. Per SIM: 3 HEADs and one 1.5 MB upload over that SIM's cellular network. Never attempted offline.
    const results: SimResult[] = [];
    for (let idx = 0; idx < simList.length; idx++) {
      const sim = simList[idx];
      const base: Omit<SimResult, "latency_ms" | "upload"> = {
        slot: sim.slot,
        mcc_mnc: sim.mccMnc,
        net_type: sim.netType,
        cells: sim.cells,
      };
      if (this.cancelled) return this.abort("cancelled");
      if (offline) {
        results.push({ ...base, latency_ms: [], upload: offlineUpload("no_network") });
        continue;
      }
      const span = 0.5 / simList.length;
      const p0 = 0.4 + idx * span;
      const simInfo = { index: idx, count: simList.length, slot: sim.slot };
      const url = `${input.probeBase.replace(/\/$/, "")}/v1/probe/${nonce}/${sim.slot}`;

      const bound = await deps.radio.bindCellular(sim.subId, opts.bindTimeoutMs).catch(() => ({ handle: null, err: "bind_error" }));
      if (bound.handle == null) {
        // The phone would not bring up mobile data on this SIM (usually: it is not the data SIM). Recorded as data.
        this.go("upload", { progress: p0 + span, sim: simInfo });
        results.push({ ...base, latency_ms: [], upload: offlineUpload(bound.err ?? "sim_unbindable") });
        continue;
      }
      try {
        this.go("latency", { progress: p0, sim: simInfo });
        const latency: (number | null)[] = [];
        for (let h = 0; h < opts.heads; h++) {
          const r = await deps.radio.headProbe(bound.handle, url, opts.headTimeoutMs).catch(() => ({ ms: null }));
          latency.push(r.ms == null ? null : Math.max(0, Math.min(120000, Math.round(r.ms))));
        }
        this.go("upload", { progress: p0 + span * 0.2, sim: simInfo });
        let upload = await this.uploadOnce(bound.handle, url, nonce!);
        const remaining = nonceExpiresAt - deps.clock.now().getTime();
        if (isRetryable(upload) && remaining >= opts.retryDelayMs + opts.uploadTimeoutMs && !this.cancelled) {
          await deps.clock.sleep(opts.retryDelayMs);
          upload = await this.uploadOnce(bound.handle, url, nonce!);
        }
        results.push({ ...base, latency_ms: latency, upload });
      } finally {
        await deps.radio.releaseCellular(bound.handle).catch(() => {});
      }
    }

    if (this.cancelled) return this.abort("cancelled");

    // 6. Seal: integrity token, then JCS + Keystore signature.
    this.go("sealing", { progress: 0.92 });
    const unsealed: UnsealedPayload = {
      v: 1,
      device_id: input.deviceId,
      nonce,
      pu_code: input.unit.pu_code,
      ts,
      fix: {
        lat: round(fix.lat, 7),
        lng: round(fix.lng, 7),
        acc_m: Math.max(0.1, round(fix.accM, 1)),
        mock: false,
      },
      sims: results,
      app: input.appVersion.slice(0, 32),
    };
    const payload = await sealPayload(unsealed, deps.integrity, deps.keys);

    // 7. Queue and send (or keep for later).
    this.go("submitting", { progress: 0.96 });
    const submit = await deps.submit(payload);
    this.go("done", { progress: 1 });
    return { kind: "completed", payload, offline, place, submit };
  }

  private async uploadOnce(handle: number, url: string, nonce: string): Promise<UploadResult> {
    try {
      return sanitizeUpload(await this.deps.radio.uploadProbe(handle, url, this.opts.uploadBytes, nonce, this.opts.uploadTimeoutMs));
    } catch (e) {
      return offlineUpload("native_error");
    }
  }
}

interface MergedSim {
  slot: number;
  subId: number;
  mccMnc: string;
  netType: string | null;
  cells: SimResult["cells"];
}

/** Join SubscriptionManager's SIM list with the snapshots; snapshots alone are used if the list is empty. */
export function mergeSims(sims: SimInfo[], samples: SimSnapshot[][]): MergedSim[] {
  const bySlot = new Map<number, { info?: SimInfo; snaps: { sample: number; snap: SimSnapshot }[] }>();
  for (const s of sims) bySlot.set(s.slot, { info: s, snaps: [] });
  samples.forEach((list, sample) => {
    for (const snap of list) {
      const e = bySlot.get(snap.slot) ?? { snaps: [] };
      e.snaps.push({ sample, snap });
      bySlot.set(snap.slot, e);
    }
  });
  const out: MergedSim[] = [];
  for (const [slot, e] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
    const cells = e.snaps.flatMap(({ sample, snap }) => toObservations(snap.cells, sample)).slice(0, 100);
    const reg = cells.find((c) => c.reg && c.mcc != null && c.mnc != null);
    const mccMnc =
      formatMccMnc(e.info?.mcc, e.info?.mnc) ??
      (reg ? formatMccMnc(reg.mcc, reg.mnc) : null) ??
      "000-00"; // unknown operator: the schema requires the field; the API treats 000 as unknown
    const netTypes = e.snaps.map((s) => s.snap.netType).filter((t): t is string => !!t);
    out.push({
      slot,
      subId: e.info?.subId ?? e.snaps[0]?.snap.subId ?? -1,
      mccMnc,
      netType: netTypes.length ? netTypes[netTypes.length - 1].slice(0, 16) : null,
      cells,
    });
  }
  return out;
}

function intOrNull(v: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null;
}

/** Native results are trusted for shape but clamped to the schema's ranges. */
export function sanitizeUpload(u: UploadResult): UploadResult {
  const status = intOrNull(u.http_status);
  return {
    ok: !!u.ok,
    bytes: intOrNull(u.bytes, 2_097_152) ?? 0,
    dns_ms: intOrNull(u.dns_ms),
    connect_ms: intOrNull(u.connect_ms),
    tls_ms: intOrNull(u.tls_ms),
    ttfb_ms: intOrNull(u.ttfb_ms),
    total_ms: intOrNull(u.total_ms, 600_000),
    http_status: status != null && status >= 100 && status <= 599 ? status : null,
    err: u.ok ? null : (u.err ?? "unknown").slice(0, 64),
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
