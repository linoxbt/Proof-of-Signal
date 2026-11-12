import { describe, expect, it } from "vitest";
import { BUCKETS, BUCKET_LIST, bucketSvg, displayStatus, flagClassToBucket, hueSat } from "@/lib/buckets";
import { BAND_COLORS } from "@/lib/coverage";
import en from "../../messages/en.json";

describe("bucket mapping", () => {
  it("mirrors public_unit_status", () => {
    expect(flagClassToBucket("HELD_SYSTEM_STALL")).toBe("held_system_stall");
    expect(flagClassToBucket("NOT_MEASURED")).toBe("not_enough_tests");
    expect(flagClassToBucket("PLAUSIBLE_NETWORK")).toBe("network_failure_plausible");
    expect(flagClassToBucket("UNEXPLAINED_DELAY")).toBe("needs_review");
    expect(flagClassToBucket("WATCH")).toBe("needs_review");
  });

  it("irev_state wins, unknown buckets degrade to pending", () => {
    expect(displayStatus({ bucket: "needs_review", irev_state: "uploaded" })).toBe("uploaded");
    expect(displayStatus({ bucket: "pending", irev_state: "cancelled" })).toBe("cancelled");
    expect(displayStatus({ bucket: "UNEXPLAINED_DELAY" as never, irev_state: "pending" })).toBe("pending");
    expect(displayStatus({ bucket: "network_failure_plausible", irev_state: "pending" })).toBe("network_failure_plausible");
  });

  it("uses the required public labels", () => {
    expect(en.buckets.network_failure_plausible.toLowerCase()).toBe("network failure plausible");
    expect(en.buckets.needs_review.toLowerCase()).toBe("needs review");
    expect(en.buckets.not_enough_tests.toLowerCase()).toBe("not enough tests");
  });

  it("every bucket has a distinct colour, a distinct glyph and a word", () => {
    expect(new Set(BUCKET_LIST.map((b) => b.color)).size).toBe(BUCKET_LIST.length);
    expect(new Set(BUCKET_LIST.map((b) => b.glyph)).size).toBe(BUCKET_LIST.length);
    for (const b of BUCKET_LIST) {
      expect((en.buckets as Record<string, unknown>)[b.labelKey]).toBeTypeOf("string");
      expect(bucketSvg(b.status)).toContain(b.glyph);
    }
  });

  it("never uses red (no accusation colour) for buckets or coverage bands", () => {
    for (const c of [...Object.values(BUCKETS).map((b) => b.color), ...Object.values(BAND_COLORS)]) {
      const { hue, sat } = hueSat(c);
      const reddish = sat > 0.25 && (hue < 20 || hue > 330);
      expect(reddish, `${c} hue ${hue.toFixed(0)}`).toBe(false);
    }
  });
});
