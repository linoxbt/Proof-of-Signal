// Number, interval and time formatting. Every probability the UI shows goes
// through formatEstimate so it always carries its interval.

function toPct(x: number): number {
  return Math.min(100, Math.max(0, Math.round(x * 100)));
}

function valid(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export const MISSING = "—";

/** 0.923 → "92%". */
export function formatPercent(p: number | null | undefined): string {
  return valid(p) ? `${toPct(p)}%` : MISSING;
}

/**
 * Rounded interval that always contains the rounded point estimate.
 * Returns null if any value is missing.
 */
export function roundedInterval(
  p: number | null | undefined,
  lo: number | null | undefined,
  hi: number | null | undefined,
): { p: number; lo: number; hi: number } | null {
  if (!valid(p) || !valid(lo) || !valid(hi)) return null;
  const rp = toPct(p);
  let rlo = toPct(Math.min(lo, hi));
  let rhi = toPct(Math.max(lo, hi));
  rlo = Math.min(rlo, rp);
  rhi = Math.max(rhi, rp);
  return { p: rp, lo: rlo, hi: rhi };
}

/** (0.85, 0.97) → "85–97%". */
export function formatInterval(lo: number | null | undefined, hi: number | null | undefined): string {
  if (!valid(lo) || !valid(hi)) return MISSING;
  return `${toPct(Math.min(lo, hi))}–${toPct(Math.max(lo, hi))}%`;
}

/** (0.92, 0.85, 0.97) → "92% (85–97%)". A point without its interval is never shown. */
export function formatEstimate(
  p: number | null | undefined,
  lo: number | null | undefined,
  hi: number | null | undefined,
): string {
  const r = roundedInterval(p, lo, hi);
  if (!r) return MISSING;
  return `${r.p}% (${r.lo}–${r.hi}%)`;
}

/** Interval width in percentage points, or null. */
export function intervalWidth(lo: number | null | undefined, hi: number | null | undefined): number | null {
  if (!valid(lo) || !valid(hi)) return null;
  return Math.abs(hi - lo);
}

/** 640 → "640 m", 1234 → "1.2 km". */
export function formatDistance(m: number | null | undefined): string {
  if (!valid(m)) return MISSING;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** 140 → "2 h 20 min", 45 → "45 min". */
export function formatMinutes(min: number | null | undefined): string {
  if (!valid(min)) return MISSING;
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const watTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const watDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** RFC 3339 → "15:40 WAT" (West Africa Time). */
export function formatTimeWat(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  return `${watTime.format(d)} WAT`;
}

/** RFC 3339 → "12 Dec 2026, 15:40 WAT". */
export function formatDateTimeWat(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  return `${watDateTime.format(d)} WAT`;
}

/** "a3f9…" style abbreviation of a hex hash; the full value stays available to copy. */
export function shortHash(hex: string | null | undefined, head = 12, tail = 6): string {
  if (!hex) return MISSING;
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** Share of a total as a whole percent, safe for total = 0. */
export function share(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((part / total) * 100);
}
