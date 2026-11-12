import { describe, expect, it } from "vitest";
import { ApiClient } from "@/lib/api/client";
import { REGISTER_COLUMNS, parseCsv } from "@/lib/csv";
import { DEMO_FLAGGED_PU, NIGHT_STEPS, STALL_BANNER } from "@/lib/demo/fixtures";
import { DEMO_REVIEWERS, DemoStore } from "@/lib/demo/store";
import { DEMO_API_BASE, createDemoFetch } from "@/lib/demo/transport";

function setup(step = NIGHT_STEPS.length - 1) {
  const store = new DemoStore();
  store.setStep(step);
  return { store, api: new ApiClient(DEMO_API_BASE, createDemoFetch(store)) };
}

const [A, B] = DEMO_REVIEWERS;
const QUEUE = { classes: ["UNEXPLAINED_DELAY", "WATCH"] as const, statuses: ["unreviewed", "awaiting_second"] as const };

describe("demo transport (contract shapes)", () => {
  it("serves state 99 only, with synthetic codes", async () => {
    const { api } = setup();
    const fc = await api.mapCoverage(99);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(20);
    for (const f of fc.features) {
      expect(f.properties.pu_code.startsWith("99-")).toBe(true);
      expect(Object.keys(f.properties).sort()).toEqual(
        ["carriers", "lga", "measured", "n_tests", "name", "p_best", "p_hi", "p_lo", "pu_code", "ward"].sort(),
      );
      if (f.properties.p_best !== null) {
        expect(f.properties.p_lo!).toBeLessThanOrEqual(f.properties.p_best);
        expect(f.properties.p_hi!).toBeGreaterThanOrEqual(f.properties.p_best);
      }
    }
    expect((await api.mapCoverage(24)).features).toHaveLength(0);
  });

  it("register is ascending by p_best with contract actions; CSV has the contract header", async () => {
    const { api } = setup();
    const reg = await api.register({ state: 99 });
    const ps = reg.rows.map((r) => r.p_best);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
    expect(reg.rows[0].suggested_action).toBe("satellite or alternate upload point");
    const csv = parseCsv(await api.registerCsv({ state: 99 }));
    expect(csv[0]).toEqual([...REGISTER_COLUMNS]);
    expect(csv.length - 1).toBe(reg.rows.length);
  });

  it("shows the stall banner only at the stall step", async () => {
    const stall = await setup(3).api.nightSummary("replay-demo");
    expect(stall.system_stall).toMatchObject({ active: true, banner: STALL_BANNER });
    const units = await setup(3).api.nightUnits("replay-demo");
    expect(units.features.some((f) => f.properties.bucket === "held_system_stall")).toBe(true);
    const late = await setup(4).api.nightSummary("replay-demo");
    expect(late.system_stall).toEqual({ active: false, since: null, banner: null });
  });

  it("never exposes a class name in public buckets", async () => {
    const units = await setup(4).api.nightUnits("replay-demo");
    const buckets = new Set(units.features.map((f) => f.properties.bucket));
    for (const b of buckets) expect(["uploaded", "pending", "network_failure_plausible", "needs_review", "not_enough_tests", "held_system_stall"]).toContain(b);
    expect(buckets.has("needs_review")).toBe(true);
    expect(buckets.has("network_failure_plausible")).toBe(true);
    expect(buckets.has("not_enough_tests")).toBe(true);
  });

  it("requires a token for flags and lists the flagged unit first", async () => {
    const { api } = setup();
    await expect(api.flags("replay-demo", {}, "")).rejects.toMatchObject({ status: 401 });
    const { flags } = await api.flags("replay-demo", { classes: [...QUEUE.classes], statuses: [...QUEUE.statuses] }, A.token);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].pu_code).toBe(DEMO_FLAGGED_PU);
    expect(flags[0].class).toBe("UNEXPLAINED_DELAY");
    const e = flags[0].evidence;
    expect(e.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.caveat).toMatch(/not a finding/);
    expect(e.p_network + e.p_other + e.p_delay).toBeCloseTo(1, 3);
    const mins = flags.map((f) => f.evidence.minutes_pending);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });

  it("enforces the two-person rule", async () => {
    const { api } = setup();
    const { flags } = await api.flags("replay-demo", { classes: [...QUEUE.classes] }, A.token);
    const id = flags[0].id;
    const f1 = await api.reviewFlag(id, "concern_confirmed", "", A.token);
    expect(f1.review_status).toBe("awaiting_second");
    await expect(api.reviewFlag(id, "concern_confirmed", "", A.token)).rejects.toMatchObject({ status: 409 });
    const f2 = await api.reviewFlag(id, "concern_confirmed", "agree", B.token);
    expect(f2.review_status).toBe("concern_confirmed");
    expect(f2.reviews.map((r) => r.reviewer_id)).toEqual([A.id, B.id]);
    const units = await api.nightUnits("replay-demo");
    expect(units.features.find((f) => f.properties.pu_code === DEMO_FLAGGED_PU)?.properties.review_outcome).toBe("concern_raised");
  });

  it("rejects explained without a note at the API too", async () => {
    const { store } = setup();
    const raw = createDemoFetch(store);
    const { flags } = await new ApiClient(DEMO_API_BASE, raw).flags("replay-demo", {}, A.token);
    const res = await raw(`${DEMO_API_BASE}/v1/flags/${flags[0].id}/review`, {
      method: "POST",
      headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "explained" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "invalid_body", message: expect.any(String) } });
  });

  it("returns 404 in the contract error shape", async () => {
    await expect(setup().api.coverage("99-99-99-999")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
