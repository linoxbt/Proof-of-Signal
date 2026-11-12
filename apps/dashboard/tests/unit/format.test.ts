import { describe, expect, it } from "vitest";
import { coverageBand } from "@/lib/coverage";
import {
  formatDistance,
  formatEstimate,
  formatInterval,
  formatMinutes,
  formatPercent,
  formatTimeWat,
  roundedInterval,
  shortHash,
} from "@/lib/format";

describe("formatting", () => {
  it("formats an estimate with its interval", () => {
    expect(formatEstimate(0.92, 0.85, 0.97)).toBe("92% (85–97%)");
    expect(formatEstimate(0.004, 0, 0.71)).toBe("0% (0–71%)");
  });

  it("never shows a point without its interval", () => {
    expect(formatEstimate(0.5, null, 0.6)).toBe("—");
    expect(formatEstimate(null, 0.1, 0.6)).toBe("—");
  });

  it("keeps the rounded estimate inside the rounded interval", () => {
    expect(roundedInterval(0.905, 0.9049, 0.95)).toEqual({ p: 91, lo: 90, hi: 95 });
    const r = roundedInterval(0.5, 0.6, 0.4)!; // swapped bounds
    expect(r.lo).toBeLessThanOrEqual(r.p);
    expect(r.hi).toBeGreaterThanOrEqual(r.p);
  });

  it("clamps to 0–100", () => {
    expect(formatPercent(1.2)).toBe("100%");
    expect(formatPercent(-0.1)).toBe("0%");
    expect(formatInterval(-0.1, 1.5)).toBe("0–100%");
    expect(formatPercent(Number.NaN)).toBe("—");
  });

  it("formats distances, durations, times and hashes", () => {
    expect(formatDistance(640)).toBe("640 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(140)).toBe("2 h 20 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatTimeWat("2026-12-12T14:30:00Z")).toBe("15:30 WAT");
    expect(shortHash("a".repeat(64))).toBe(`${"a".repeat(12)}…${"a".repeat(6)}`);
  });

  it("bands use the register cut points", () => {
    expect(coverageBand(0.19)).toBe("very_weak");
    expect(coverageBand(0.2)).toBe("weak");
    expect(coverageBand(0.5)).toBe("fair");
    expect(coverageBand(0.8)).toBe("good");
    expect(coverageBand(null)).toBe("none");
  });
});
