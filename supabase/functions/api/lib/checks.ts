// Ingest checks and trust (contracts/api.md "Checks"). Pure functions: the
// handler gathers distances and rows from Postgres, these decide.

export const PROBE_BYTES = 1_572_864;
export const TA_METRES = 78.12;
export const TELEPORT_KMH = 150;

export interface CheckInput {
  mock: boolean;
  accM: number;
  /** Unit point and distance from the fix (metres), or null when the unit has no point. */
  puDistM: number | null;
  placeRadiusM: number;
  /** Nearest-in-time earlier/later test by the device within 24 h that still has a raw fix. */
  prev: { distM: number; dtS: number; accM: number } | null;
  /** SIM slots whose upload claims ok. */
  okSlots: number[];
  receipts: { slot: number; bytes: number; asn: number | null; mobileAsn: boolean }[];
  /** Registered cells found in `cells` with a point. */
  cells: { radio: string; distM: number; rangeM: number | null; ta: number | null }[];
  tsMs: number;
  nowMs: number;
}

export interface CheckResult {
  status: "accepted" | "quarantined" | "rejected";
  reason: string | null;
  /** Side effect the caller must apply. */
  quarantineDevice: boolean;
}

const accepted: CheckResult = { status: "accepted", reason: null, quarantineDevice: false };
const q = (reason: string, quarantineDevice = false): CheckResult => ({
  status: "quarantined",
  reason,
  quarantineDevice,
});
const r = (reason: string): CheckResult => ({ status: "rejected", reason, quarantineDevice: false });

/**
 * Teleport speed in km/h. Conservative: the two fixes' accuracy radii are
 * subtracted from the distance, and the time gap is floored at 1 s.
 */
export function impliedSpeedKmh(distM: number, dtS: number, accA: number, accB: number): number {
  const d = Math.max(0, distM - accA - accB);
  if (d === 0) return 0;
  return (d / Math.max(Math.abs(dtS), 1)) * 3.6;
}

export function taMismatch(ta: number, distM: number): boolean {
  return Math.abs(ta * TA_METRES - distM) > Math.max(1000, 0.5 * distM);
}

export function runChecks(c: CheckInput): CheckResult {
  if (c.mock) return q("mock_location");
  if (c.accM > 30) return r("low_accuracy");
  if (c.puDistM !== null && c.puDistM > c.placeRadiusM) return q("too_far");
  if (c.prev && impliedSpeedKmh(c.prev.distM, c.prev.dtS, c.accM, c.prev.accM) > TELEPORT_KMH) {
    return q("teleport", true);
  }
  for (const slot of c.okSlots) {
    if (!c.receipts.some((x) => x.slot === slot && x.bytes === PROBE_BYTES)) return r("no_probe_receipt");
  }
  if (c.receipts.some((x) => x.asn !== null && !x.mobileAsn)) return r("not_mobile_network");
  for (const cell of c.cells) {
    if (cell.rangeM !== null && cell.distM > cell.rangeM + 1000) return q("cell_mismatch");
  }
  for (const cell of c.cells) {
    if (cell.radio === "LTE" && cell.ta !== null && taMismatch(cell.ta, cell.distM)) return q("ta_mismatch");
  }
  if (c.tsMs > c.nowMs + 10 * 60_000 || c.tsMs < c.nowMs - 7 * 86_400_000) return r("bad_timestamp");
  return accepted;
}

/** 1 within 50 m, linear to 0.5 at 150 m (and below beyond); 0.7 when the unit has no point. */
export function placeScore(puDistM: number | null): number {
  if (puDistM === null) return 0.7;
  if (puDistM <= 50) return 1;
  return Math.max(0, 1 - 0.5 * ((puDistM - 50) / 100));
}

export function trust(status: CheckResult["status"], reputation: number, puDistM: number | null, outlier = 1): number {
  if (status !== "accepted") return 0;
  const t = reputation * placeScore(puDistM) * outlier;
  return Math.round(Math.min(1, Math.max(0, t)) * 1000) / 1000;
}
