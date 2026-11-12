import type { CellObservation } from "../contracts";
import type { RawCell } from "./ports";

// Ranges from contracts/test-payload.schema.json. A value outside its range is a modem quirk (some chipsets
// report 0 or Integer.MAX_VALUE-adjacent sentinels), so it becomes null rather than failing the whole payload.
const RANGES: Record<string, [number, number]> = {
  mcc: [0, 999],
  mnc: [0, 999],
  area: [0, Number.MAX_SAFE_INTEGER],
  cid: [0, Number.MAX_SAFE_INTEGER],
  pci: [0, 1007],
  earfcn: [0, Number.MAX_SAFE_INTEGER],
  rsrp: [-156, -31],
  rsrq: [-43, 20],
  rssnr: [-23, 40],
  rssi: [-140, 0],
  ta: [0, 1282],
  level: [0, 4],
};

const FIELDS = Object.keys(RANGES) as (keyof typeof RANGES)[];

export const MAX_CELLS_PER_SIM = 100;
export const SAMPLES = 5;
/** Per sample: the registered cell(s) plus the strongest neighbours, so 5 samples fit in the schema's 100. */
const MAX_CELLS_PER_SAMPLE = Math.floor(MAX_CELLS_PER_SIM / SAMPLES);

function clean(v: number | null | undefined, [lo, hi]: [number, number]): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < lo || n > hi ? null : n;
}

/**
 * Convert one sample's raw cells to payload observations. Android radio names are kept as they are
 * ("WCDMA" stays "WCDMA"); the API maps WCDMA to UMTS on ingest.
 */
export function toObservations(raw: RawCell[], sample: number): CellObservation[] {
  const strength = (c: RawCell) => c.rsrp ?? c.rssi ?? -999;
  const sorted = [...raw].sort((a, b) => Number(b.reg) - Number(a.reg) || strength(b) - strength(a));
  return sorted.slice(0, MAX_CELLS_PER_SAMPLE).map((c) => {
    const o: CellObservation = { reg: !!c.reg, radio: c.radio, sample };
    for (const f of FIELDS) {
      (o as unknown as Record<string, number | null>)[f] = clean((c as unknown as Record<string, number | null>)[f], RANGES[f]);
    }
    return o;
  });
}

/** Median signal level (0..4) of the registered cell across samples, for the result screen's bars. */
export function registeredLevel(cells: CellObservation[]): number | null {
  const levels = cells.filter((c) => c.reg && c.level != null).map((c) => c.level as number).sort((a, b) => a - b);
  if (levels.length === 0) return null;
  return levels[Math.floor(levels.length / 2)];
}
