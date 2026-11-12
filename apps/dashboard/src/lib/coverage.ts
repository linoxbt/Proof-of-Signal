// Coverage colour scale and bands. Sequential (light → dark blue) so it reads
// in greyscale and for colour-blind users; every band also has a word.

export type CoverageBand = "very_weak" | "weak" | "fair" | "good" | "none";

/** Same cut points as the register's suggested_action (contracts/api.md). */
export function coverageBand(p: number | null | undefined): CoverageBand {
  if (typeof p !== "number" || !Number.isFinite(p)) return "none";
  if (p < 0.2) return "very_weak";
  if (p < 0.5) return "weak";
  if (p < 0.8) return "fair";
  return "good";
}

export const BAND_ORDER: CoverageBand[] = ["very_weak", "weak", "fair", "good", "none"];

export const BAND_COLORS: Record<CoverageBand, string> = {
  very_weak: "#e8eef6",
  weak: "#a6c4e0",
  fair: "#4f8fc4",
  good: "#0b4a87",
  none: "#ffffff",
};

/** Dot outline so pale bands stay visible on the background. */
export const BAND_STROKE = "#334155";

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const CARRIERS: { mnc: number; name: string }[] = [
  { mnc: 30, name: "MTN" },
  { mnc: 20, name: "Airtel" },
  { mnc: 50, name: "Glo" },
  { mnc: 60, name: "9mobile" },
];

export function carrierName(mnc: number | string): string {
  const n = Number(mnc);
  return CARRIERS.find((c) => c.mnc === n)?.name ?? `MNC ${mnc}`;
}
