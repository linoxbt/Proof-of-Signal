// Synthetic demo data. State code 99 does not exist in Nigeria (codes run 01
// to 37), so none of this can be mistaken for a real polling unit. The first
// five units match supabase/seed.sql. Everything is generated from a fixed
// seed, so every load and every test sees the same data.
//
// The night timeline applies the watcher maths from contracts/api.md
// (three-cause plausibility, classes in order) to a scripted upload timeline
// with a system-wide stall between minutes 72 and 112.

import { suggestedAction } from "../csv";
import { CARRIERS } from "../coverage";
import type {
  CarrierCoverage,
  CoverageFeatureProps,
  CoverageResponse,
  Election,
  Evidence,
  FeatureCollection,
  FlagClass,
  LgaProgress,
  MethodResponse,
  NightSummary,
  NightUnitProps,
  PublicBucket,
  RegisterRow,
} from "../api/types";
import { flagClassToBucket } from "../buckets";

export const DEMO_STATE_CODE = 99;
export const DEMO_STATE_NAME = "Demo State";
export const DEMO_ELECTION_ID = "replay-demo";
export const DEMO_POLLS_CLOSE_AT = "2026-12-12T14:30:00Z";
export const DEMO_MODEL_VERSION = "2026-12-08.1";
export const DEMO_SNAPSHOT_ID = "5c1f6a2e-9d0b-4c47-8a51-3e2f0d7b9a10";
export const DEMO_SNAPSHOT_SHA256 = "b7d5353d28d476cce003057643212913f28ecfad425c61be9af3ac981c71ec74";

export const CAVEAT =
  "This system cannot see BVAS faults, flat batteries, late starts, insecurity, cancelled polls, tower power cuts or congestion on the day. A flag is a request for human review, not a finding.";

export const STALL_BANNER = "Uploads paused system-wide: the cause is not field network coverage";

/** Watcher tunables (elections.config defaults in contracts/api.md). */
export const WATCHER_CONFIG = {
  strong_cut: 0.8,
  weak_cut: 0.4,
  prior_other_q: 0.05,
  neighbour_factor_r: 0.3,
  not_measured_interval: 0.4,
  p_network_plausible: 0.6,
  p_other_flag: 0.6,
  neighbour_min: 3,
};

/** Scripted stall window (minutes after polls close). */
export const STALL_START_MIN = 72;
export const STALL_END_MIN = 112;

/**
 * Demo-only grace period before the first classification. The contract
 * classifies from t = 0, but at polls close nearly every unit is pending and
 * would read "needs review"; the demo starts classifying at 62 minutes so the
 * early timeline shows plain "pending". See the README.
 */
export const DEMO_GRACE_MIN = 62;

export interface NightStep {
  minutes: number;
  /** i18n key under demo.steps */
  key: "close" | "early" | "busy" | "stall" | "late";
}

export const NIGHT_STEPS: NightStep[] = [
  { minutes: 0, key: "close" },
  { minutes: 30, key: "early" },
  { minutes: 60, key: "busy" },
  { minutes: 95, key: "stall" },
  { minutes: 140, key: "late" },
];

export const DEFAULT_NIGHT_STEP = NIGHT_STEPS.length - 1;

// ---------------------------------------------------------------------------
// Deterministic generator

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const clamp01 = (x: number) => Math.min(0.999, Math.max(0.001, x));

export interface DemoCarrier {
  mnc: number;
  carrier: string;
  p: number;
  p_lo: number;
  p_hi: number;
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  measured: boolean;
}

export interface DemoUnit {
  pu_code: string;
  name: string;
  ward: string;
  ward_code: number;
  lga: string;
  lga_code: number;
  state: string;
  lat: number | null;
  lng: number | null;
  /** null: no prediction yet */
  carriers: DemoCarrier[] | null;
  best: { p: number; p_lo: number; p_hi: number; measured: boolean; n_tests: number } | null;
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  /** minutes after close of the first IReV sighting, null = never in the demo night */
  upload_min: number | null;
  cancelled_min: number | null;
}

interface WardDef {
  code: number;
  name: string;
  center: [number, number]; // lng, lat
  /** base signal quality 0..1 */
  quality: number;
}

interface LgaDef {
  code: number;
  name: string;
  wards: WardDef[];
}

const LGAS: LgaDef[] = [
  {
    code: 1,
    name: "Demo North",
    wards: [
      { code: 1, name: "Ward A", center: [4.556, 8.49], quality: 0.97 },
      { code: 2, name: "Ward B", center: [4.62, 8.54], quality: 0.78 },
      { code: 3, name: "Ward C", center: [4.5, 8.55], quality: 0.86 },
    ],
  },
  {
    code: 2,
    name: "Demo South",
    wards: [
      { code: 1, name: "Ward D", center: [4.53, 8.41], quality: 0.84 },
      { code: 2, name: "Ward E", center: [4.6, 8.38], quality: 0.55 },
    ],
  },
  {
    code: 3,
    name: "Demo East",
    wards: [
      { code: 1, name: "Ward F", center: [4.72, 8.48], quality: 0.34 },
      { code: 2, name: "Ward G", center: [4.76, 8.42], quality: 0.17 },
    ],
  },
];

const PLACE_KINDS = [
  "Primary School",
  "Market Square",
  "Town Hall",
  "Health Centre",
  "Village Square",
  "Junior Secondary School",
  "Community Hall",
  "Motor Park",
  "Water Tank Junction",
  "Civic Centre",
  "Farm Settlement",
  "Old Post Office",
];

/** The five units from supabase/seed.sql, kept with their codes and names. */
const SEED_UNITS: Record<string, { name: string; lng: number | null; lat: number | null }> = {
  "99-01-01-001": { name: "Demo Primary School I", lng: 4.55, lat: 8.49 },
  "99-01-01-002": { name: "Demo Market Square", lng: 4.556, lat: 8.493 },
  "99-01-01-003": { name: "Demo Town Hall", lng: 4.561, lat: 8.487 },
  "99-01-02-001": { name: "Demo Health Centre", lng: 4.62, lat: 8.54 },
  "99-01-02-002": { name: "Demo Village Square", lng: null, lat: null },
};

/** The measured, strong unit that stays pending after its ward has uploaded. */
export const DEMO_FLAGGED_PU = "99-01-01-002";

const CARRIER_STRENGTH: Record<number, number> = { 30: 0.72, 20: 0.52, 50: 0.36, 60: 0.2 };
const UNITS_PER_WARD = 8;

function makeUnits(): DemoUnit[] {
  const rnd = mulberry32(20261212);
  const units: DemoUnit[] = [];
  for (const lga of LGAS) {
    for (const ward of lga.wards) {
      for (let i = 1; i <= UNITS_PER_WARD; i++) {
        const pu_code = `99-${String(lga.code).padStart(2, "0")}-${String(ward.code).padStart(2, "0")}-${String(i).padStart(3, "0")}`;
        const seed = SEED_UNITS[pu_code];
        const jitter = () => (rnd() - 0.5) * 0.045;
        const lng = seed ? seed.lng : round(ward.center[0] + jitter(), 5);
        const lat = seed ? seed.lat : round(ward.center[1] + jitter(), 5);
        const kind = PLACE_KINDS[(units.length * 7 + i) % PLACE_KINDS.length];
        const name = seed ? seed.name : `Demo ${kind} ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][i - 1]}`;

        const q = Math.min(0.97, Math.max(0.02, ward.quality + (rnd() - 0.5) * 0.25));
        const tested = rnd() < 0.62 || pu_code === DEMO_FLAGGED_PU || pu_code === "99-01-01-001";
        const noPrediction = !tested && rnd() < 0.12;

        let carriers: DemoCarrier[] | null = null;
        let nTests = 0;
        let nDevices = 0;
        let nEvenings = 0;
        if (!noPrediction) {
          carriers = CARRIERS.map((c) => {
            const p = clamp01(q * CARRIER_STRENGTH[c.mnc] + (rnd() - 0.5) * 0.12);
            const nt = tested ? Math.floor(rnd() * 4) + (c.mnc === 30 || c.mnc === 20 ? 2 : 0) : 0;
            const measured = nt >= 3;
            const half = measured ? 0.04 + rnd() * 0.06 : nt > 0 ? 0.12 + rnd() * 0.08 : 0.18 + rnd() * 0.14;
            const nd = nt === 0 ? 0 : Math.max(1, Math.min(nt, 1 + Math.floor(rnd() * 3)));
            const ne = nt === 0 ? 0 : Math.max(1, Math.min(nt, 1 + Math.floor(rnd() * 3)));
            return {
              mnc: c.mnc,
              carrier: c.name,
              p: round(p),
              p_lo: round(Math.max(0, p - half)),
              p_hi: round(Math.min(1, p + half)),
              n_tests: nt,
              n_devices: nd,
              n_evenings: ne,
              measured,
            };
          });
          nTests = carriers.reduce((s, c) => s + c.n_tests, 0);
          nDevices = Math.max(0, ...carriers.map((c) => c.n_devices));
          nEvenings = Math.max(0, ...carriers.map((c) => c.n_evenings));
        }

        let best: DemoUnit["best"] = null;
        if (carriers) {
          // Best-carrier score: 1 − Π(1 − p_carrier); interval from the per-carrier bounds.
          const comb = (k: "p" | "p_lo" | "p_hi") => 1 - carriers!.reduce((acc, c) => acc * (1 - c[k]), 1);
          best = {
            p: round(comb("p")),
            p_lo: round(comb("p_lo")),
            p_hi: round(comb("p_hi")),
            measured: carriers.some((c) => c.measured),
            n_tests: nTests,
          };
        }

        units.push({
          pu_code,
          name,
          ward: ward.name,
          ward_code: ward.code,
          lga: lga.name,
          lga_code: lga.code,
          state: DEMO_STATE_NAME,
          lat,
          lng,
          carriers,
          best,
          n_tests: nTests,
          n_devices: nDevices,
          n_evenings: nEvenings,
          upload_min: null,
          cancelled_min: null,
        });
      }
    }
  }

  // Night timeline. Strong units upload early, the system stalls between
  // STALL_START_MIN and STALL_END_MIN (nobody uploads), uploads resume, and
  // weak units mostly never upload. The flagged unit never uploads.
  const t = mulberry32(777);
  for (const u of units) {
    const p = u.best?.p ?? 0.5;
    const r = t();
    if (u.pu_code === DEMO_FLAGGED_PU) {
      u.upload_min = null;
    } else if (u.pu_code === "99-03-02-008") {
      u.cancelled_min = 50;
    } else if (p >= 0.8) {
      u.upload_min = r < 0.85 ? 6 + Math.floor(t() * 60) : STALL_END_MIN + 2 + Math.floor(t() * 20);
    } else if (p >= 0.45) {
      u.upload_min = r < 0.45 ? 15 + Math.floor(t() * 50) : r < 0.85 ? STALL_END_MIN + 4 + Math.floor(t() * 24) : null;
    } else {
      u.upload_min = r < 0.1 ? STALL_END_MIN + 8 + Math.floor(t() * 20) : null;
    }
    // Nothing reaches IReV during the stall.
    if (u.upload_min !== null && u.upload_min >= STALL_START_MIN - 6 && u.upload_min < STALL_END_MIN) {
      u.upload_min = STALL_START_MIN - 8 - Math.floor(t() * 10);
    }
  }
  return units;
}

export const DEMO_UNITS: DemoUnit[] = makeUnits();

const addMinutes = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Public coverage endpoints

export function demoCoverage(puCode: string): CoverageResponse | null {
  const u = DEMO_UNITS.find((x) => x.pu_code === puCode);
  if (!u) return null;
  const carriers: CarrierCoverage[] = (u.carriers ?? []).map((c) => ({
    mcc: 621,
    mnc: c.mnc,
    carrier: c.carrier,
    p: c.p,
    p_lo: c.p_lo,
    p_hi: c.p_hi,
    n_tests: c.n_tests,
    n_devices: c.n_devices,
    n_evenings: c.n_evenings,
    measured: c.measured,
  }));
  return {
    pu_code: u.pu_code,
    name: u.name,
    ward: u.ward,
    lga: u.lga,
    state: u.state,
    lat: u.lat,
    lng: u.lng,
    model_version: u.best ? DEMO_MODEL_VERSION : null,
    best: u.best,
    carriers,
  };
}

export function demoMapCoverage(state: number, lga?: number): FeatureCollection<CoverageFeatureProps> {
  const units = state === DEMO_STATE_CODE ? DEMO_UNITS.filter((u) => lga === undefined || u.lga_code === lga) : [];
  return {
    type: "FeatureCollection",
    features: units
      .filter((u) => u.lat !== null && u.lng !== null)
      .map((u) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [u.lng as number, u.lat as number] as [number, number] },
        properties: {
          pu_code: u.pu_code,
          name: u.name,
          ward: u.ward,
          lga: u.lga,
          p_best: u.best?.p ?? null,
          p_lo: u.best?.p_lo ?? null,
          p_hi: u.best?.p_hi ?? null,
          n_tests: u.n_tests,
          measured: u.best?.measured ?? false,
          carriers: Object.fromEntries((u.carriers ?? []).map((c) => [String(c.mnc), c.p])),
        },
      })),
  };
}

export function demoMapProgress(state: number): { lgas: LgaProgress[] } {
  if (state !== DEMO_STATE_CODE) return { lgas: [] };
  return {
    lgas: LGAS.map((l) => {
      const us = DEMO_UNITS.filter((u) => u.lga_code === l.code);
      return {
        lga_code: l.code,
        lga: l.name,
        units: us.length,
        tested: us.filter((u) => u.n_tests > 0).length,
        measured: us.filter((u) => u.best?.measured).length,
      };
    }),
  };
}

export function demoRegister(q: { state?: number; lga?: number; limit?: number }): { model_version: string; rows: RegisterRow[] } {
  const limit = Math.min(Math.max(1, q.limit ?? 500), 5000);
  const rows = DEMO_UNITS.filter(
    (u) => u.best && (q.state === undefined || q.state === DEMO_STATE_CODE) && (q.lga === undefined || u.lga_code === q.lga),
  )
    .sort((a, b) => a.best!.p - b.best!.p || a.pu_code.localeCompare(b.pu_code))
    .slice(0, limit)
    .map((u) => ({
      pu_code: u.pu_code,
      name: u.name,
      ward: u.ward,
      lga: u.lga,
      state: u.state,
      p_best: u.best!.p,
      p_lo: u.best!.p_lo,
      p_hi: u.best!.p_hi,
      n_tests: u.n_tests,
      carriers_seen: (u.carriers ?? [])
        .filter((c) => c.n_tests > 0)
        .map((c) => c.carrier)
        .join(";"),
      suggested_action: suggestedAction(u.best!.p),
    }));
  return { model_version: DEMO_MODEL_VERSION, rows };
}

export function demoSearch(q: string, limit = 10) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { units: [] };
  return {
    units: DEMO_UNITS.filter((u) => u.pu_code.startsWith(needle) || u.name.toLowerCase().includes(needle))
      .slice(0, Math.min(limit, 50))
      .map((u) => ({
        pu_code: u.pu_code,
        name: u.name,
        ward: u.ward,
        lga: u.lga,
        state: u.state,
        lat: u.lat,
        lng: u.lng,
        geom_source: u.lat === null ? null : ("inec" as const),
        progress: {
          n_tests: u.n_tests,
          n_devices: u.n_devices,
          n_evenings: u.n_evenings,
          measured: u.best?.measured ?? false,
          needed: Math.max(0, 3 - u.n_tests),
        },
      })),
  };
}

export const DEMO_ELECTION: Election = {
  id: DEMO_ELECTION_ID,
  name: "Synthetic replay (demo)",
  election_date: "2026-12-12",
  state_codes: [DEMO_STATE_CODE],
  polls_close_at: DEMO_POLLS_CLOSE_AT,
  is_replay: true,
  snapshot: {
    id: DEMO_SNAPSHOT_ID,
    sha256: DEMO_SNAPSHOT_SHA256,
    frozen_at: "2026-12-11T21:00:00Z",
    model_version: DEMO_MODEL_VERSION,
    tsa_at: "2026-12-11T21:00:04Z",
  },
};

export const DEMO_METHOD: MethodResponse = {
  model_versions: [
    {
      id: DEMO_MODEL_VERSION,
      trained_at: "2026-12-08T03:12:00Z",
      metrics: { auc: 0.87, brier: 0.11, ece: 0.03, n_train_tests: 1240, n_units_measured: 318 },
      is_current: true,
    },
    {
      id: "2026-11-20.1",
      trained_at: "2026-11-20T02:40:00Z",
      metrics: { auc: 0.83, brier: 0.13, ece: 0.05, n_train_tests: 610, n_units_measured: 142 },
      is_current: false,
    },
  ],
  snapshots: [
    {
      id: DEMO_SNAPSHOT_ID,
      election_id: DEMO_ELECTION_ID,
      model_version: DEMO_MODEL_VERSION,
      frozen_at: "2026-12-11T21:00:00Z",
      sha256: DEMO_SNAPSHOT_SHA256,
      row_count: DEMO_UNITS.length * CARRIERS.length,
      tsa_at: "2026-12-11T21:00:04Z",
    },
  ],
  audit_roots: [
    { day: "2026-12-11", root_hash: "d9169035f0f9b5b4979d1a5d46cddff185a581ae12e713b847cefeb865144287", tsa_at: "2026-12-12T00:05:02Z" },
    { day: "2026-12-10", root_hash: "81cce1224593b215f5550e3f949c0f8656c450aa3e16d5bf7ae33e36533a52e0", tsa_at: "2026-12-11T00:05:01Z" },
    { day: "2026-12-09", root_hash: "4d2bc582df99833694c94ace5796d214ee63238b617709f368d78abb0f89a12c", tsa_at: "2026-12-10T00:05:03Z" },
  ],
};

// ---------------------------------------------------------------------------
// Night: watcher maths

export interface Classified {
  unit: DemoUnit;
  cls: FlagClass;
  s_t: number;
  m: number;
  p_network: number;
  p_other: number;
  p_delay: number;
  /** first minute (≥ grace) at which this unit had its current class without interruption */
  since_min: number;
}

const uploadedBy = (u: DemoUnit, t: number) => u.upload_min !== null && u.upload_min <= t;
const cancelledBy = (u: DemoUnit, t: number) => u.cancelled_min !== null && u.cancelled_min <= t;

export function stallActive(t: number): boolean {
  return t >= STALL_START_MIN && t < STALL_END_MIN;
}

function strongShare(t: number): number {
  const strong = DEMO_UNITS.filter((u) => (u.best?.p ?? 0) >= WATCHER_CONFIG.strong_cut && !cancelledBy(u, t));
  if (!strong.length) return 0.001;
  return Math.max(0.001, strong.filter((u) => !uploadedBy(u, t)).length / strong.length);
}

function classifyAt(u: DemoUnit, t: number, sCache: Map<number, number>): Omit<Classified, "since_min"> {
  let s_t = sCache.get(t);
  if (s_t === undefined) {
    s_t = strongShare(t);
    sCache.set(t, s_t);
  }
  const b = u.best;
  const p = b?.p ?? 0;
  const measured = b?.measured ?? false;
  const width = b ? b.p_hi - b.p_lo : 1;
  const m = Math.min(
    5,
    DEMO_UNITS.filter((o) => o !== u && o.lga_code === u.lga_code && o.ward_code === u.ward_code && uploadedBy(o, t)).length,
  );
  const { prior_other_q: q, neighbour_factor_r: r } = WATCHER_CONFIG;
  const N = (1 - p) * r ** m;
  const O = p * q;
  const D = p * (1 - q) * s_t;
  const Z = N + O + D || 1;
  const p_network = N / Z;
  const p_other = O / Z;
  const p_delay = D / Z;
  let cls: FlagClass;
  if (stallActive(t)) cls = "HELD_SYSTEM_STALL";
  else if (!measured && width > WATCHER_CONFIG.not_measured_interval) cls = "NOT_MEASURED";
  else if (p_network >= WATCHER_CONFIG.p_network_plausible) cls = "PLAUSIBLE_NETWORK";
  else if (p_other >= WATCHER_CONFIG.p_other_flag && measured && m >= WATCHER_CONFIG.neighbour_min) cls = "UNEXPLAINED_DELAY";
  else cls = "WATCH";
  return { unit: u, cls, s_t, m, p_network, p_other, p_delay };
}

const classifyCache = new Map<number, Classified[]>();

/** Classified pending units (those with a flag) at minute t. */
export function classifyAll(t: number): Classified[] {
  const hit = classifyCache.get(t);
  if (hit) return hit;
  const out: Classified[] = [];
  if (t >= DEMO_GRACE_MIN) {
    const sCache = new Map<number, number>();
    for (const u of DEMO_UNITS) {
      if (u.lat === null || uploadedBy(u, t) || cancelledBy(u, t)) continue;
      const now = classifyAt(u, t, sCache);
      let since = t;
      for (let k = t - 1; k >= DEMO_GRACE_MIN; k--) {
        if (classifyAt(u, k, sCache).cls !== now.cls) break;
        since = k;
      }
      out.push({ ...now, since_min: since });
    }
  }
  classifyCache.set(t, out);
  return out;
}

export function demoFlagId(puCode: string): string {
  const idx = DEMO_UNITS.findIndex((u) => u.pu_code === puCode);
  return `f1a90000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
}

export function demoEvidence(c: Classified, t: number): Evidence {
  const u = c.unit;
  const neighboursAll = DEMO_UNITS.filter(
    (o) => o !== u && o.lga_code === u.lga_code && o.ward_code === u.ward_code && uploadedBy(o, t),
  );
  const dist = (o: DemoUnit) =>
    u.lat === null || o.lat === null || u.lng === null || o.lng === null
      ? null
      : Math.round(
          6371000 *
            2 *
            Math.asin(
              Math.sqrt(
                Math.sin(((o.lat - u.lat) * Math.PI) / 360) ** 2 +
                  Math.cos((u.lat * Math.PI) / 180) * Math.cos((o.lat * Math.PI) / 180) * Math.sin(((o.lng - u.lng) * Math.PI) / 360) ** 2,
              ),
            ),
        );
  const neighbours = neighboursAll
    .map((o) => ({
      pu_code: o.pu_code,
      name: o.name,
      dist_m: dist(o),
      uploaded_at: addMinutes(DEMO_POLLS_CLOSE_AT, o.upload_min as number),
      shared: "ward" as const,
    }))
    .sort((a, b) => (a.dist_m ?? Infinity) - (b.dist_m ?? Infinity))
    .slice(0, 5);
  return {
    pu_code: u.pu_code,
    name: u.name,
    ward: u.ward,
    lga: u.lga,
    snapshot_id: DEMO_SNAPSHOT_ID,
    snapshot_sha256: DEMO_SNAPSHOT_SHA256,
    measured: u.best?.measured ?? false,
    n_tests: u.n_tests,
    n_devices: u.n_devices,
    n_evenings: u.n_evenings,
    carriers: (u.carriers ?? []).map((k) => ({ mnc: k.mnc, carrier: k.carrier, p: k.p, p_lo: k.p_lo, p_hi: k.p_hi })),
    p_best: u.best?.p ?? 0,
    p_best_lo: u.best?.p_lo ?? 0,
    p_best_hi: u.best?.p_hi ?? 1,
    neighbours,
    neighbours_uploaded: neighboursAll.length,
    minutes_since_close: t,
    minutes_pending: t,
    s_t: round(c.s_t, 4),
    p_network: round(c.p_network, 4),
    p_other: round(c.p_other, 4),
    p_delay: round(c.p_delay, 4),
    caveat: CAVEAT,
  };
}

export function demoNightSummary(t: number): NightSummary {
  const units = DEMO_UNITS;
  const uploaded = units.filter((u) => uploadedBy(u, t)).length;
  const cancelled = units.filter((u) => cancelledBy(u, t)).length;
  const pending = units.length - uploaded - cancelled;
  const active = stallActive(t);
  return {
    election_id: DEMO_ELECTION_ID,
    polls_close_at: DEMO_POLLS_CLOSE_AT,
    minutes_since_close: t,
    system_stall: active
      ? { active: true, since: addMinutes(DEMO_POLLS_CLOSE_AT, STALL_START_MIN), banner: STALL_BANNER }
      : { active: false, since: null, banner: null },
    totals: { units: units.length, uploaded, pending, cancelled },
    states: [{ state_code: DEMO_STATE_CODE, state: DEMO_STATE_NAME, units: units.length, uploaded, pending, cancelled }],
    updated_at: addMinutes(DEMO_POLLS_CLOSE_AT, t),
  };
}

export function demoNightUnits(
  t: number,
  outcomeFor: (puCode: string) => NightUnitProps["review_outcome"],
): FeatureCollection<NightUnitProps> {
  const flags = new Map(classifyAll(t).map((c) => [c.unit.pu_code, c]));
  return {
    type: "FeatureCollection",
    // Like the real API: units with a point, cancelled units left out.
    features: DEMO_UNITS.filter((u) => u.lat !== null && u.lng !== null && !cancelledBy(u, t)).map((u) => {
      const up = uploadedBy(u, t);
      const canc = cancelledBy(u, t);
      const c = flags.get(u.pu_code);
      const bucket: PublicBucket = up ? "uploaded" : c ? flagClassToBucket(c.cls) : "pending";
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [u.lng as number, u.lat as number] as [number, number] },
        properties: {
          pu_code: u.pu_code,
          name: u.name,
          ward: u.ward,
          lga: u.lga,
          irev_state: up ? "uploaded" : canc ? "cancelled" : "pending",
          first_seen_at: up ? addMinutes(DEMO_POLLS_CLOSE_AT, u.upload_min as number) : null,
          bucket,
          review_outcome: c ? outcomeFor(u.pu_code) : null,
        },
      };
    }),
  };
}

export function minutesToIso(t: number): string {
  return addMinutes(DEMO_POLLS_CLOSE_AT, t);
}
