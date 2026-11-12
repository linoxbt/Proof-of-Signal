import { latLngToCell } from "h3-js";
import type { CoverageFeatureProps, PointFeature } from "./api/types";

export interface HexCell {
  hex: string;
  units: number;
  /** best unit in the cell (highest value), with its interval */
  best: { pu_code: string; p: number; p_lo: number | null; p_hi: number | null; n_tests: number } | null;
  n_tests: number;
  measured: number;
}

/**
 * Aggregate unit points into H3 cells. Each cell is coloured by its best unit,
 * consistent with the "best available" framing of the map.
 */
export function aggregateHexes(
  features: PointFeature<CoverageFeatureProps>[],
  value: (p: CoverageFeatureProps) => number | null,
  resolution = 8,
): HexCell[] {
  const cells = new Map<string, HexCell>();
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    const hex = latLngToCell(lat, lng, resolution);
    let c = cells.get(hex);
    if (!c) {
      c = { hex, units: 0, best: null, n_tests: 0, measured: 0 };
      cells.set(hex, c);
    }
    c.units++;
    c.n_tests += f.properties.n_tests;
    if (f.properties.measured) c.measured++;
    const v = value(f.properties);
    if (v !== null && (!c.best || v > c.best.p)) {
      c.best = { pu_code: f.properties.pu_code, p: v, p_lo: f.properties.p_lo, p_hi: f.properties.p_hi, n_tests: f.properties.n_tests };
    }
  }
  return [...cells.values()];
}
