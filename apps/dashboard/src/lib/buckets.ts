// Public election-night buckets. Hard rules: no red, no accusation colour;
// every bucket has a distinct hue AND a distinct glyph AND a word.
import type { FlagClass, IrevState, NightUnitProps, PublicBucket } from "./api/types";

/** Display status: the contract's six buckets plus cancelled units (irev_state). */
export type DisplayStatus = PublicBucket | "cancelled";

export interface BucketMeta {
  status: DisplayStatus;
  /** i18n key under `buckets.` */
  labelKey: DisplayStatus;
  color: string;
  /** SVG path data for a white glyph on a 24×24 viewBox, drawn over a filled circle. */
  glyph: string;
  /** Sort order for legends and lists. */
  order: number;
}

export const BUCKETS: Record<DisplayStatus, BucketMeta> = {
  network_failure_plausible: {
    status: "network_failure_plausible",
    labelKey: "network_failure_plausible",
    color: "#0072b2",
    // signal bars
    glyph: "M7 17v-2M10.5 17v-5M14 17v-8M17.5 17v-11",
    order: 0,
  },
  needs_review: {
    status: "needs_review",
    labelKey: "needs_review",
    color: "#6d4fb3",
    // magnifier
    glyph: "M10.5 6.5a4 4 0 1 0 0 8a4 4 0 1 0 0-8M13.5 13.5l4 4",
    order: 1,
  },
  not_enough_tests: {
    status: "not_enough_tests",
    labelKey: "not_enough_tests",
    color: "#a07c12",
    // question mark
    glyph: "M9.2 9.2a2.8 2.8 0 1 1 3.9 2.6c-.7.3-1.1.9-1.1 1.6v.6M12 17.2v.3",
    order: 2,
  },
  held_system_stall: {
    status: "held_system_stall",
    labelKey: "held_system_stall",
    color: "#2a8fa8",
    // pause
    glyph: "M9.5 7.5v9M14.5 7.5v9",
    order: 3,
  },
  pending: {
    status: "pending",
    labelKey: "pending",
    color: "#7a8089",
    // clock
    glyph: "M12 6.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M12 9v3.2l2.2 1.4",
    order: 4,
  },
  uploaded: {
    status: "uploaded",
    labelKey: "uploaded",
    color: "#00845f",
    // check
    glyph: "M7 12.5l3.2 3.2L17 9",
    order: 5,
  },
  cancelled: {
    status: "cancelled",
    labelKey: "cancelled",
    color: "#4b5563",
    // dash
    glyph: "M7.5 12h9",
    order: 6,
  },
};

export const BUCKET_LIST: BucketMeta[] = Object.values(BUCKETS).sort((a, b) => a.order - b.order);

const PUBLIC_BUCKETS: ReadonlySet<string> = new Set<PublicBucket>([
  "uploaded",
  "pending",
  "network_failure_plausible",
  "needs_review",
  "not_enough_tests",
  "held_system_stall",
]);

export function isPublicBucket(x: unknown): x is PublicBucket {
  return typeof x === "string" && PUBLIC_BUCKETS.has(x);
}

/**
 * Mirrors the `public_unit_status` view: WATCH and UNEXPLAINED_DELAY both read
 * "needs review" in public; the class name itself is never shown publicly.
 */
export function flagClassToBucket(cls: FlagClass): PublicBucket {
  switch (cls) {
    case "HELD_SYSTEM_STALL":
      return "held_system_stall";
    case "NOT_MEASURED":
      return "not_enough_tests";
    case "PLAUSIBLE_NETWORK":
      return "network_failure_plausible";
    case "UNEXPLAINED_DELAY":
    case "WATCH":
      return "needs_review";
  }
}

/** What to show for a unit on the night map. Unknown buckets degrade to "pending". */
export function displayStatus(u: Pick<NightUnitProps, "bucket" | "irev_state">): DisplayStatus {
  const irev: IrevState | undefined = u.irev_state;
  if (irev === "cancelled") return "cancelled";
  if (irev === "uploaded") return "uploaded";
  return isPublicBucket(u.bucket) ? u.bucket : "pending";
}

/** Self-contained SVG (for deck.gl IconLayer and the legend). */
export function bucketSvg(status: DisplayStatus, size = 48): string {
  const m = BUCKETS[status];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11" fill="${m.color}" stroke="#ffffff" stroke-width="1.5"/>` +
    `<path d="${m.glyph}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

export function bucketSvgDataUrl(status: DisplayStatus, size = 48): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bucketSvg(status, size))}`;
}

/** Hue in degrees (0–360) and saturation (0–1) of a #rrggbb colour. */
export function hueSat(hex: string): { hue: number; sat: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, sat };
}
