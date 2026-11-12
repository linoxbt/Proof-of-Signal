import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { type CheckInput, impliedSpeedKmh, placeScore, runChecks, taMismatch, trust } from "../lib/checks.ts";
import { dbRadio, validatePayload } from "../lib/schema.ts";
import { sim } from "./helpers.ts";

const NOW = Date.parse("2026-12-02T19:00:00Z");
const base: CheckInput = {
  mock: false,
  accM: 10,
  puDistM: 20,
  placeRadiusM: 150,
  prev: null,
  okSlots: [0],
  receipts: [{ slot: 0, bytes: 1572864, asn: 29465, mobileAsn: true }],
  cells: [{ radio: "LTE", distM: 550, rangeM: 2000, ta: 7 }],
  tsMs: NOW - 60_000,
  nowMs: NOW,
};
const run = (o: Partial<CheckInput>) => runChecks({ ...base, ...o });

Deno.test("checks: clean test is accepted", () => {
  assertEquals(run({}), { status: "accepted", reason: null, quarantineDevice: false });
});

Deno.test("checks: each rule and its outcome", () => {
  assertEquals(run({ mock: true }).reason, "mock_location");
  assertEquals(run({ mock: true }).status, "quarantined");
  assertEquals(run({ accM: 30 }).status, "accepted");
  assertEquals(run({ accM: 30.1 }), { status: "rejected", reason: "low_accuracy", quarantineDevice: false });
  assertEquals(run({ puDistM: 150 }).status, "accepted");
  assertEquals(run({ puDistM: 151 }).reason, "too_far");
  assertEquals(run({ puDistM: null }).status, "accepted"); // no point: no place check
  assertEquals(run({ prev: { distM: 50_000, dtS: 600, accM: 10 } }), {
    status: "quarantined",
    reason: "teleport",
    quarantineDevice: true,
  });
  assertEquals(run({ prev: { distM: 20_000, dtS: 600, accM: 10 } }).status, "accepted"); // ~120 km/h
  assertEquals(run({ receipts: [] }).reason, "no_probe_receipt");
  assertEquals(run({ receipts: [{ slot: 0, bytes: 1000, asn: null, mobileAsn: false }] }).reason, "no_probe_receipt");
  assertEquals(
    run({ receipts: [{ slot: 1, bytes: 1572864, asn: null, mobileAsn: false }] }).reason,
    "no_probe_receipt",
  );
  assertEquals(run({ receipts: [{ slot: 0, bytes: 1572864, asn: null, mobileAsn: false }] }).status, "accepted");
  assertEquals(
    run({ receipts: [{ slot: 0, bytes: 1572864, asn: 15169, mobileAsn: false }] }).reason,
    "not_mobile_network",
  );
  assertEquals(run({ cells: [{ radio: "LTE", distM: 3001, rangeM: 2000, ta: null }] }).reason, "cell_mismatch");
  assertEquals(run({ cells: [{ radio: "LTE", distM: 2999, rangeM: 2000, ta: null }] }).status, "accepted");
  assertEquals(run({ cells: [{ radio: "LTE", distM: 50_000, rangeM: null, ta: null }] }).status, "accepted");
  assertEquals(run({ cells: [{ radio: "LTE", distM: 550, rangeM: null, ta: 40 }] }).reason, "ta_mismatch");
  assertEquals(run({ cells: [{ radio: "GSM", distM: 550, rangeM: null, ta: 40 }] }).status, "accepted");
  assertEquals(run({ tsMs: NOW + 10 * 60_000 }).status, "accepted");
  assertEquals(run({ tsMs: NOW + 10 * 60_000 + 1 }).reason, "bad_timestamp");
  assertEquals(run({ tsMs: NOW - 7 * 86_400_000 - 1 }).reason, "bad_timestamp");
  // Offline run: no ok uploads, no receipts needed.
  assertEquals(run({ okSlots: [], receipts: [] }).status, "accepted");
});

Deno.test("checks: first failure wins", () => {
  assertEquals(run({ mock: true, accM: 100, puDistM: 999 }).reason, "mock_location");
  assertEquals(run({ accM: 100, puDistM: 999 }).reason, "low_accuracy");
  assertEquals(run({ puDistM: 999, receipts: [] }).reason, "too_far");
  assertEquals(run({ receipts: [], tsMs: 0 }).reason, "no_probe_receipt");
  assertEquals(
    run({ cells: [{ radio: "LTE", distM: 5000, rangeM: 1000, ta: 1 }], tsMs: 0 }).reason,
    "cell_mismatch",
  );
});

Deno.test("checks: teleport speed subtracts accuracy and floors dt", () => {
  assertEquals(impliedSpeedKmh(40, 0, 10, 30), 0);
  assertAlmostEquals(impliedSpeedKmh(1020, 60, 10, 10), 60, 1e-9);
  assertEquals(impliedSpeedKmh(1000, 0, 0, 0), 3600);
});

Deno.test("checks: timing advance tolerance", () => {
  assertEquals(taMismatch(7, 550), false); // 547 m vs 550 m
  assertEquals(taMismatch(40, 550), true); // 3125 m vs 550 m
  assertEquals(taMismatch(100, 7000), false); // 7812 vs 7000, tolerance 3500
  assertEquals(taMismatch(0, 1000), false); // tolerance floor 1000
});

Deno.test("trust: reputation x place score, zero unless accepted", () => {
  assertEquals(placeScore(0), 1);
  assertEquals(placeScore(50), 1);
  assertEquals(placeScore(100), 0.75);
  assertEquals(placeScore(150), 0.5);
  assertEquals(placeScore(null), 0.7);
  assertEquals(trust("accepted", 0.5, 10), 0.5);
  assertEquals(trust("accepted", 0.5, null), 0.35);
  assertEquals(trust("accepted", 0.9, 100), 0.675);
  assertEquals(trust("accepted", 1, 0, 0.2), 0.2);
  assertEquals(trust("quarantined", 1, 0), 0);
  assertEquals(trust("rejected", 1, 0), 0);
});

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    device_id: "6f1c1f9e-6c2a-4d2b-9b8f-0d7e4a0c1b2a",
    nonce: "n_AAAAAAAAAAAAAAAAAAAAAA",
    pu_code: "99-01-01-001",
    ts: "2026-12-02T19:14:05+01:00",
    fix: { lat: 8.49, lng: 4.55, acc_m: 9, mock: false },
    sims: [sim(0, true)],
    app: "1.0.0",
    integrity: "tok",
    sig: "MEUCIQ==",
    ...over,
  };
}

Deno.test("schema: bundled copy equals contracts/test-payload.schema.json", async () => {
  const here = new URL("../schema/test-payload.schema.json", import.meta.url);
  const contract = new URL("../../../../contracts/test-payload.schema.json", import.meta.url);
  assertEquals(JSON.parse(await Deno.readTextFile(here)), JSON.parse(await Deno.readTextFile(contract)));
});

Deno.test("schema: valid payloads pass, violations are reported", () => {
  assertEquals(validatePayload(payload()), null);
  assertEquals(validatePayload(payload({ nonce: null, sims: [sim(0, false)] })), null);
  const cases: Record<string, unknown>[] = [
    { v: 2 },
    { device_id: "not-a-uuid" },
    { nonce: "n_short" },
    { pu_code: "99-1-01-001" },
    { ts: "yesterday" },
    { ts: "2026-12-02T19:14:05" }, // no offset
    { fix: { lat: 50, lng: 4.55, acc_m: 9, mock: false } },
    { fix: { lat: 8.49, lng: 4.55, acc_m: 0, mock: false } },
    { sims: [] },
    { sims: [sim(0, true), sim(0, true)] }, // duplicate slot
    { sims: [sim(4, true)] },
    { nonce: null }, // offline with an ok upload
    { extra: 1 },
    { sims: [{ ...sim(0, true), cells: [{ reg: true, radio: "5G", sample: 0 }] }] },
  ];
  for (const c of cases) {
    const p: Record<string, unknown> = payload(c);
    assert(validatePayload(p) !== null, `expected violation for ${JSON.stringify(c)}`);
  }
  const missing: Record<string, unknown> = payload();
  delete missing.sig;
  assert(validatePayload(missing) !== null);
});

Deno.test("radio: WCDMA is stored as UMTS", () => {
  assertEquals(dbRadio("WCDMA"), "UMTS");
  assertEquals(dbRadio("LTE"), "LTE");
  assertEquals(dbRadio("UMTS"), "UMTS");
});
