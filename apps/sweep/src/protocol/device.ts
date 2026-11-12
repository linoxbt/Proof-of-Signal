import { base64Decode } from "./bytes";
import type { QueueStore } from "./queue";
import type { ApiPort, Clock, IntegrityPort, KeyPort } from "./ports";
import { registrationRequestHash, signErase } from "./sign";
import { rfc3339Local } from "./time";

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryKv implements KvStore {
  readonly data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}

export const KV_DEVICE_ID = "device_id";
export const KV_DEVICE_STATUS = "device_status";

export interface Registration {
  deviceId: string;
  status: string;
  integrityLevel: string | null;
}

/**
 * First launch: create the Keystore key, bind a Play Integrity token to it, and POST /v1/devices.
 * Idempotent on the server (same pubkey returns the same device), and locally (stored device id wins).
 */
export async function ensureRegistered(
  deps: { keys: KeyPort; integrity: IntegrityPort; api: ApiPort; kv: KvStore },
  appVersion: string,
): Promise<Registration> {
  const existing = await deps.kv.get(KV_DEVICE_ID);
  if (existing) {
    return { deviceId: existing, status: (await deps.kv.get(KV_DEVICE_STATUS)) ?? "active", integrityLevel: null };
  }
  await deps.keys.ensureKey();
  const pubkey = await deps.keys.publicKey();
  const token = await deps.integrity.token(registrationRequestHash(base64Decode(pubkey)));
  const res = await deps.api.registerDevice({ pubkey, integrity_token: token, app_version: appVersion });
  await deps.kv.set(KV_DEVICE_ID, res.device_id);
  await deps.kv.set(KV_DEVICE_STATUS, res.status);
  return { deviceId: res.device_id, status: res.status, integrityLevel: res.integrity_level };
}

/**
 * "Delete my data": signed DELETE /v1/devices/{id}/data, then wipe the local history and queue (queued tests
 * are the volunteer's data too, so they are dropped, not sent). The key and device id stay so the volunteer
 * can keep contributing; the server keeps no tests for it.
 */
export async function eraseMyData(
  deps: { keys: KeyPort; api: ApiPort; kv: KvStore; queue: QueueStore; clock: Clock },
): Promise<{ testsDeleted: number }> {
  const deviceId = await deps.kv.get(KV_DEVICE_ID);
  if (!deviceId) {
    await deps.queue.clear();
    return { testsDeleted: 0 };
  }
  const body = await signErase(deviceId, rfc3339Local(deps.clock.now()), deps.keys);
  const res = await deps.api.eraseDeviceData(deviceId, body);
  await deps.queue.clear();
  return { testsDeleted: res.tests_deleted };
}
