import { ApiError } from "../src/protocol/api";
import { base64Encode, base64UrlEncode, utf8Encode } from "../src/protocol/bytes";
import { checkPlace, distanceM } from "../src/protocol/geo";
import { canonicalize } from "../src/protocol/jcs";
import { MemoryQueueStore, SyncEngine } from "../src/protocol/queue";
import { TestRun, TRANSITIONS, UPLOAD_BYTES, formatMccMnc, type RunEvent } from "../src/protocol/run";
import { sha256 } from "../src/protocol/sha256";
import { signedBytes, testRequestHash } from "../src/protocol/sign";
import {
  DEVICE_ID,
  FakeApi,
  FakeClock,
  FakeIntegrity,
  FakeKeys,
  FakeLocation,
  FakeNet,
  FakeRadio,
  NONCE,
  UNIT,
  type CallLog,
  lteCell,
  okUpload,
  validatePayload,
  verifySig,
} from "./helpers/fakes";

const PROBE = "https://probe.test";

function setup() {
  const log: CallLog = [];
  const clock = new FakeClock();
  const radio = new FakeRadio(log);
  const keys = new FakeKeys(log);
  const integrity = new FakeIntegrity(log);
  const location = new FakeLocation();
  const net = new FakeNet();
  const api = new FakeApi(clock);
  const store = new MemoryQueueStore();
  const sync = new SyncEngine(store, api, () => clock.now());
  const events: RunEvent[] = [];
  const make = (unit: { pu_code: string; lat: number | null; lng: number | null } = UNIT) =>
    new TestRun(
      { radio, keys, integrity, location, api, net, clock, submit: (p) => sync.submit(p) },
      { deviceId: DEVICE_ID, unit, appVersion: "1.0.0", probeBase: PROBE },
      (e) => events.push(e),
    );
  return { log, clock, radio, keys, integrity, location, net, api, store, sync, events, make };
}

describe("online run", () => {
  test("produces a payload that validates against contracts/test-payload.schema.json", async () => {
    const s = setup();
    const out = await s.make().run();
    expect(out.kind).toBe("completed");
    if (out.kind !== "completed") return;
    const v = validatePayload(out.payload);
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);

    expect(out.offline).toBe(false);
    expect(out.payload.nonce).toBe(NONCE);
    expect(out.payload.sims).toHaveLength(2);
    expect(out.payload.sims.map((x) => x.mcc_mnc)).toEqual(["621-30", "621-20"]);
    expect(out.payload.sims.every((x) => x.upload.ok)).toBe(true);
    expect(out.payload.sims.every((x) => x.latency_ms.length === 3)).toBe(true);
    // 5 samples per SIM, sample index 0..4
    expect(new Set(out.payload.sims[0].cells.map((c) => c.sample))).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(out.payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(out.submit.state).toBe("synced");
  });

  test("probe URLs carry the nonce and slot; each SIM uploads exactly 1,572,864 bytes on its own network", async () => {
    const s = setup();
    await s.make().run();
    expect(s.radio.uploadUrls).toEqual([`${PROBE}/v1/probe/${NONCE}/0`, `${PROBE}/v1/probe/${NONCE}/1`]);
    expect(s.radio.heads).toHaveLength(6);
    expect(s.log.filter((l) => l.startsWith("upload:"))).toEqual([`upload:${UPLOAD_BYTES}`, `upload:${UPLOAD_BYTES}`]);
    expect(s.log.filter((l) => l.startsWith("bind:"))).toEqual(["bind:1", "bind:2"]);
    expect(s.radio.released).toEqual([1001, 1002]);
  });

  test("5 radio snapshots taken 2 s apart", async () => {
    const s = setup();
    await s.make().run();
    expect(s.log.filter((l) => l === "snapshot")).toHaveLength(5);
    expect(s.clock.sleeps.filter((ms) => ms === 2000)).toHaveLength(4);
  });

  test("WCDMA cells stay WCDMA in the payload (the API maps them to UMTS)", async () => {
    const s = setup();
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    const sim1 = out.payload.sims.find((x) => x.slot === 1)!;
    expect(sim1.cells.length).toBe(5);
    expect(sim1.cells.every((c) => c.radio === "WCDMA")).toBe(true);
    expect(JSON.stringify(out.payload)).not.toContain('"UMTS"');
  });

  test("out-of-range modem values become null instead of breaking the schema", async () => {
    const s = setup();
    s.radio.cellsBySlot[0] = [lteCell({ rsrp: 0, ta: 2147483647, pci: 5000, level: 9 })];
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    const c = out.payload.sims[0].cells[0];
    expect([c.rsrp, c.ta, c.pci, c.level]).toEqual([null, null, null, null]);
    expect(validatePayload(out.payload).valid).toBe(true);
  });

  test("state machine only takes allowed transitions and ends in done", async () => {
    const s = setup();
    await s.make().run();
    const phases = s.events.map((e) => e.phase);
    let prev = "idle" as keyof typeof TRANSITIONS;
    for (const p of phases) {
      expect(p === prev || TRANSITIONS[prev].includes(p)).toBe(true);
      prev = p;
    }
    expect(phases[phases.length - 1]).toBe("done");
    expect(s.events.map((e) => e.progress)).toEqual([...s.events.map((e) => e.progress)].sort((a, b) => a - b));
  });

  test("a SIM whose mobile data cannot be brought up is recorded as a failed upload, not sent over Wi-Fi", async () => {
    const s = setup();
    s.radio.bindErrBySub[2] = "sim_unbindable";
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    const sim1 = out.payload.sims.find((x) => x.slot === 1)!;
    expect(sim1.upload).toMatchObject({ ok: false, err: "sim_unbindable", bytes: 0 });
    expect(sim1.latency_ms).toEqual([]);
    expect(s.radio.uploadUrls).toHaveLength(1);
    expect(validatePayload(out.payload).valid).toBe(true);
  });
});

describe("signing", () => {
  test("call order: integrity token, then one signature over JCS(payload without sig) that includes the token", async () => {
    const s = setup();
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    const tail = s.log.slice(s.log.lastIndexOf("integrity"));
    expect(tail).toEqual(["integrity", "sign"]);
    expect(s.log.filter((l) => l === "sign")).toHaveLength(1);
    expect(s.log.indexOf("integrity")).toBeGreaterThan(s.log.lastIndexOf(`upload:${UPLOAD_BYTES}`));

    const { sig, ...rest } = out.payload;
    const expectedBytes = Buffer.from(canonicalize(rest), "utf8");
    expect(s.keys.signed[0].equals(expectedBytes)).toBe(true);
    expect(Buffer.from(signedBytes(out.payload)).equals(expectedBytes)).toBe(true);
    expect(rest.integrity).toBe(`itok.${base64UrlEncode(sha256(utf8Encode(NONCE)))}`);
    expect(verifySig(await s.keys.publicKey(), expectedBytes, sig)).toBe(true);
  });

  test("signature does not verify once any field changes", async () => {
    const s = setup();
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    const tampered = { ...out.payload, pu_code: "99-01-01-002" };
    expect(verifySig(await s.keys.publicKey(), signedBytes(tampered), out.payload.sig)).toBe(false);
  });

  test("signed bytes are independent of member order", () => {
    const a = signedBytes({ v: 1, device_id: "x", sig: "zzz" } as never);
    const b = signedBytes({ sig: "yyy", device_id: "x", v: 1 } as never);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(base64Encode(a)).toBe(Buffer.from('{"device_id":"x","v":1}').toString("base64"));
  });
});

describe("offline run", () => {
  test("nonce null, every upload ok false with no_network, no probe traffic, still schema-valid and queued", async () => {
    const s = setup();
    s.net.online = false;
    s.api.online = false;
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    expect(out.offline).toBe(true);
    expect(out.payload.nonce).toBeNull();
    expect(out.payload.sims.every((x) => x.upload.ok === false && x.upload.err === "no_network")).toBe(true);
    expect(out.payload.sims.every((x) => x.latency_ms.length === 0)).toBe(true);
    expect(s.radio.uploadUrls).toHaveLength(0);
    expect(s.radio.heads).toHaveLength(0);
    expect(s.log.some((l) => l.startsWith("bind:"))).toBe(false);
    expect(validatePayload(out.payload).valid).toBe(true);
    // Integrity request hash for offline runs: base64url(sha256(device_id + "|" + ts)).
    expect(s.integrity.hashes[0]).toBe(base64UrlEncode(sha256(utf8Encode(`${DEVICE_ID}|${out.payload.ts}`))));
    expect(s.integrity.hashes[0]).toBe(testRequestHash(out.payload));
    // Queued, not lost.
    expect(out.submit.state).toBe("pending");
    expect((await s.store.pending()).map((i) => i.offline)).toEqual([true]);
  });

  test("network says online but the nonce request fails to connect: treated as offline", async () => {
    const s = setup();
    s.api.online = false;
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    expect(out.payload.nonce).toBeNull();
    expect(s.radio.uploadUrls).toHaveLength(0);
  });

  test("an API refusal of the nonce (device quarantined) aborts instead of pretending to be offline", async () => {
    const s = setup();
    s.api.nonceError = new ApiError(403, "device_quarantined", "quarantined");
    const out = await s.make().run();
    expect(out).toMatchObject({ kind: "aborted", reason: "api_error", detail: "device_quarantined" });
    expect(await s.store.list()).toHaveLength(0);
  });
});

describe("upload retry", () => {
  test("one retry 15 s after a timeout", async () => {
    const s = setup();
    s.radio.sims = [s.radio.sims[0]];
    s.radio.uploads = [okUpload({ ok: false, err: "timeout", http_status: null, total_ms: 120000, bytes: 800000 }), okUpload()];
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    expect(s.radio.uploadUrls).toHaveLength(2);
    expect(s.clock.sleeps).toContain(15000);
    expect(out.payload.sims[0].upload.ok).toBe(true);
  });

  test("no retry on a final probe answer (409 duplicate receipt)", async () => {
    const s = setup();
    s.radio.sims = [s.radio.sims[0]];
    s.radio.uploads = [okUpload({ ok: false, http_status: 409, err: "http_409" })];
    const out = await s.make().run();
    if (out.kind !== "completed") throw new Error("not completed");
    expect(s.radio.uploadUrls).toHaveLength(1);
    expect(out.payload.sims[0].upload).toMatchObject({ ok: false, http_status: 409, err: "http_409" });
  });

  test("no retry when the nonce would expire before a retry could finish", async () => {
    const s = setup();
    s.radio.sims = [s.radio.sims[0]];
    s.api.nonceTtlMs = 60_000;
    s.radio.uploads = [okUpload({ ok: false, err: "timeout", http_status: null })];
    await s.make().run();
    expect(s.radio.uploadUrls).toHaveLength(1);
  });
});

describe("location and place", () => {
  test("rejects a mocked fix (expo-location flag)", async () => {
    const s = setup();
    s.location.fix = { ...s.location.fix!, mocked: true };
    expect(await s.make().run()).toMatchObject({ kind: "aborted", reason: "mock_location" });
    expect(s.log).not.toContain("snapshot");
  });

  test("rejects a mocked fix (native isMock flag)", async () => {
    const s = setup();
    s.radio.mock = true;
    expect(await s.make().run()).toMatchObject({ kind: "aborted", reason: "mock_location" });
  });

  test("rejects accuracy worse than 30 m", async () => {
    const s = setup();
    s.location.fix = { ...s.location.fix!, accM: 31 };
    expect(await s.make().run()).toMatchObject({ kind: "aborted", reason: "low_accuracy", accM: 31 });
  });

  test("refuses to run more than 150 m from the unit's point, before spending any data", async () => {
    const s = setup();
    s.location.fix = { ...s.location.fix!, lat: 8.4920, lng: 4.5500 }; // ~222 m north
    const out = await s.make().run();
    expect(out).toMatchObject({ kind: "aborted", reason: "too_far" });
    if (out.kind === "aborted") expect(out.distanceM).toBeGreaterThan(150);
    expect(s.log).not.toContain("snapshot");
    expect(s.radio.uploadUrls).toHaveLength(0);
  });

  test("a unit with no point turns the fix into a location vote", async () => {
    const s = setup();
    const out = await s.make({ pu_code: "99-01-01-005", lat: null, lng: null }).run();
    expect(out.kind).toBe("completed");
    if (out.kind === "completed") expect(out.place).toEqual({ kind: "location_vote" });
  });

  test("checkPlace boundaries and haversine sanity", () => {
    expect(distanceM(8.49, 4.55, 8.49, 4.55)).toBe(0);
    // 0.001 degree of latitude is ~111.2 m
    expect(distanceM(8.49, 4.55, 8.491, 4.55)).toBeCloseTo(111.2, 0);
    expect(checkPlace({ lat: 8.491, lng: 4.55 }, UNIT).kind).toBe("ok");
    expect(checkPlace({ lat: 8.4913, lng: 4.55 }, UNIT).kind).toBe("ok"); // ~144.6 m
    expect(checkPlace({ lat: 8.4914, lng: 4.55 }, UNIT).kind).toBe("too_far"); // ~155.7 m
    expect(checkPlace({ lat: 8.4914, lng: 4.55 }, { lat: null, lng: null }).kind).toBe("location_vote");
  });

  test("no SIM: abort", async () => {
    const s = setup();
    s.radio.sims = [];
    expect(await s.make().run()).toMatchObject({ kind: "aborted", reason: "no_sims" });
  });
});

describe("mcc_mnc formatting", () => {
  test.each([
    ["621", "30", "621-30"],
    ["621", "01", "621-01"],
    [621, 1, "621-01"],
    ["621", "130", "621-130"],
    [null, "30", null],
    ["62a", "30", null],
  ])("%p %p -> %p", (mcc, mnc, out) => {
    expect(formatMccMnc(mcc as never, mnc as never)).toBe(out);
  });
});

describe("cancel", () => {
  test("cancelling during sampling aborts and nothing is queued or uploaded", async () => {
    const s = setup();
    const run = s.make();
    const orig = s.radio.snapshot.bind(s.radio);
    let n = 0;
    s.radio.snapshot = async () => {
      if (++n === 2) run.cancel();
      return orig();
    };
    expect(await run.run()).toMatchObject({ kind: "aborted", reason: "cancelled" });
    expect(s.radio.uploadUrls).toHaveLength(0);
    expect(await s.store.list()).toHaveLength(0);
  });
});
