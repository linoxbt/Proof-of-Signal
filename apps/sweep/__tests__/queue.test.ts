import { ApiError } from "../src/protocol/api";
import { ensureRegistered, eraseMyData, KV_DEVICE_ID, MemoryKv } from "../src/protocol/device";
import { canonicalize } from "../src/protocol/jcs";
import { MemoryQueueStore, SyncEngine } from "../src/protocol/queue";
import { TestRun } from "../src/protocol/run";
import { payloadSha256Hex, registrationRequestHash } from "../src/protocol/sign";
import { base64Decode } from "../src/protocol/bytes";
import type { TestPayload } from "../src/contracts";
import {
  DEVICE_ID,
  FakeApi,
  FakeClock,
  FakeIntegrity,
  FakeKeys,
  FakeLocation,
  FakeNet,
  FakeRadio,
  UNIT,
  verifySig,
} from "./helpers/fakes";

async function makePayload(offline = true): Promise<TestPayload> {
  const clock = new FakeClock();
  const api = new FakeApi(clock);
  const net = new FakeNet();
  net.online = !offline;
  let captured: TestPayload | null = null;
  const run = new TestRun(
    {
      radio: new FakeRadio(),
      keys: new FakeKeys(),
      integrity: new FakeIntegrity(),
      location: new FakeLocation(),
      api,
      net,
      clock,
      submit: async (p) => {
        captured = p;
        return { state: "pending", error: null };
      },
    },
    { deviceId: DEVICE_ID, unit: UNIT, appVersion: "1.0.0", probeBase: "https://probe.test" },
  );
  await run.run();
  return captured!;
}

describe("queue and sync", () => {
  test("enqueue is idempotent: same payload, one item keyed by payload_sha256", async () => {
    const store = new MemoryQueueStore();
    const api = new FakeApi();
    const sync = new SyncEngine(store, api);
    const p = await makePayload();
    const a = await sync.enqueue(p);
    const b = await sync.enqueue(JSON.parse(JSON.stringify(p)));
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(payloadSha256Hex(p));
    expect(await store.list()).toHaveLength(1);
  });

  test("offline: stays pending; when a connection returns, sync sends it once and marks it synced", async () => {
    const store = new MemoryQueueStore();
    const api = new FakeApi();
    api.online = false;
    const sync = new SyncEngine(store, api);
    const p = await makePayload();
    const out = await sync.submit(p);
    expect(out.state).toBe("pending");
    expect((await store.pending())[0].attempts).toBe(1);

    api.online = true;
    const r1 = await sync.sync();
    expect(r1).toEqual({ sent: 1, failed: 0, stillPending: 0 });
    expect((await store.list())[0].state).toBe("synced");

    const r2 = await sync.sync();
    expect(r2.sent).toBe(0);
    expect(api.posts).toHaveLength(1);
  });

  test("a lost response is safe: re-sending returns the stored result (server dedupes by payload_sha256)", async () => {
    const api = new FakeApi();
    const p = await makePayload();
    const first = await api.submitTest(p); // reached the server, but the phone never saw the answer
    const store = new MemoryQueueStore();
    const sync = new SyncEngine(store, api);
    const out = await sync.submit(p);
    expect(out).toEqual({ state: "synced", response: first });
    expect(api.stored.size).toBe(1);
  });

  test("concurrent sync calls share one pass, so nothing is posted twice at once", async () => {
    const store = new MemoryQueueStore();
    const api = new FakeApi();
    const sync = new SyncEngine(store, api);
    await sync.enqueue(await makePayload());
    await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
    expect(api.posts).toHaveLength(1);
  });

  test("definitive 4xx marks the item failed and it is never resent; 5xx/429 stay pending", async () => {
    const store = new MemoryQueueStore();
    const api = new FakeApi();
    const sync = new SyncEngine(store, api);
    const p1 = await makePayload();

    api.submitError = new ApiError(503, "internal", "down");
    expect((await sync.submit(p1)).state).toBe("pending");
    api.submitError = new ApiError(429, "rate_limited", "slow down", 30);
    await sync.sync();
    expect((await store.pending()).length).toBe(1);

    api.submitError = new ApiError(400, "schema_violation", "bad");
    await sync.sync();
    const [item] = await store.list();
    expect(item.state).toBe("failed");
    expect(item.last_error).toBe("schema_violation: bad");
    const posts = api.posts.length;
    api.submitError = null;
    await sync.sync();
    expect(api.posts.length).toBe(posts);
  });

  test("online run payload with ok uploads also syncs and dedupes", async () => {
    const store = new MemoryQueueStore();
    const api = new FakeApi();
    const sync = new SyncEngine(store, api);
    const p = await makePayload(false);
    expect(p.nonce).not.toBeNull();
    await sync.submit(p);
    await sync.submit(p);
    expect(api.stored.size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("device registration and erasure", () => {
  test("registers once with an integrity token bound to sha256(pubkey DER)", async () => {
    const keys = new FakeKeys();
    const integrity = new FakeIntegrity();
    const api = new FakeApi();
    const kv = new MemoryKv();
    const spy = jest.spyOn(api, "registerDevice");
    const r = await ensureRegistered({ keys, integrity, api, kv }, "1.0.0");
    expect(r.deviceId).toBe(DEVICE_ID);
    expect(integrity.hashes[0]).toBe(registrationRequestHash(base64Decode(await keys.publicKey())));
    expect(spy).toHaveBeenCalledWith({ pubkey: await keys.publicKey(), integrity_token: `itok.${integrity.hashes[0]}`, app_version: "1.0.0" });
    await ensureRegistered({ keys, integrity, api, kv }, "1.0.0");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV_DEVICE_ID)).toBe(DEVICE_ID);
  });

  test("erase signs JCS({device_id, op:'erase', ts}) and clears the local queue", async () => {
    const keys = new FakeKeys();
    const api = new FakeApi();
    const kv = new MemoryKv();
    await kv.set(KV_DEVICE_ID, DEVICE_ID);
    const queue = new MemoryQueueStore();
    await new SyncEngine(queue, api).enqueue(await makePayload());
    const res = await eraseMyData({ keys, api, kv, queue, clock: new FakeClock() });
    expect(res.testsDeleted).toBe(0);
    const { id, body } = api.erases[0];
    expect(id).toBe(DEVICE_ID);
    const bytes = Buffer.from(canonicalize({ device_id: DEVICE_ID, op: "erase", ts: body.ts }));
    expect(bytes.toString()).toBe(`{"device_id":"${DEVICE_ID}","op":"erase","ts":"${body.ts}"}`);
    expect(verifySig(await keys.publicKey(), bytes, body.sig)).toBe(true);
    expect(await queue.list()).toHaveLength(0);
  });

  test("erase offline fails and keeps local data", async () => {
    const api = new FakeApi();
    api.online = false;
    const kv = new MemoryKv();
    await kv.set(KV_DEVICE_ID, DEVICE_ID);
    const queue = new MemoryQueueStore();
    await new SyncEngine(queue, new FakeApi()).enqueue(await makePayload());
    await expect(eraseMyData({ keys: new FakeKeys(), api, kv, queue, clock: new FakeClock() })).rejects.toThrow();
    expect(await queue.list()).toHaveLength(1);
  });
});
