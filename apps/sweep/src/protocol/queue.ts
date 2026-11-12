// Every sealed payload is written to the queue before any network attempt, then synced. The queue key is the
// payload's sha256 (the API's dedupe key), so enqueueing the same payload twice is a no-op, and re-sending a
// payload the server already holds returns 200 with the stored result. Sync is safe to repeat at any time.

import type { TestPayload, TestResponse } from "../contracts";
import { ApiError, NetworkError } from "./api";
import type { ApiPort } from "./ports";
import type { SubmitOutcome } from "./run";
import { payloadSha256Hex } from "./sign";

export type QueueState = "pending" | "synced" | "failed";

export interface QueueItem {
  id: string; // payload_sha256 hex
  created_at: string; // ISO
  pu_code: string;
  offline: boolean; // nonce null
  payload: TestPayload;
  state: QueueState;
  attempts: number;
  last_error: string | null;
  response: TestResponse | null;
  synced_at: string | null;
}

export interface QueueStore {
  /** Insert if absent. Returns false when an item with this id already exists. */
  insert(item: QueueItem): Promise<boolean>;
  get(id: string): Promise<QueueItem | null>;
  pending(): Promise<QueueItem[]>; // oldest first
  list(): Promise<QueueItem[]>; // newest first
  markSynced(id: string, response: TestResponse, at: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  noteAttempt(id: string, error: string | null): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryQueueStore implements QueueStore {
  private items = new Map<string, QueueItem>();
  async insert(item: QueueItem) {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, structuredCloneSafe(item));
    return true;
  }
  async get(id: string) {
    const i = this.items.get(id);
    return i ? structuredCloneSafe(i) : null;
  }
  async pending() {
    return [...this.items.values()].filter((i) => i.state === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async list() {
    return [...this.items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async markSynced(id: string, response: TestResponse, at: string) {
    const i = this.items.get(id);
    if (i) Object.assign(i, { state: "synced", response, synced_at: at, last_error: null });
  }
  async markFailed(id: string, error: string) {
    const i = this.items.get(id);
    if (i) Object.assign(i, { state: "failed", last_error: error });
  }
  async noteAttempt(id: string, error: string | null) {
    const i = this.items.get(id);
    if (i) Object.assign(i, { attempts: i.attempts + 1, last_error: error });
  }
  async clear() {
    this.items.clear();
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface SyncReport {
  sent: number;
  failed: number;
  stillPending: number;
}

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: QueueStore,
    private readonly api: ApiPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async enqueue(payload: TestPayload): Promise<QueueItem> {
    const id = payloadSha256Hex(payload);
    const item: QueueItem = {
      id,
      created_at: this.now().toISOString(),
      pu_code: payload.pu_code,
      offline: payload.nonce == null,
      payload,
      state: "pending",
      attempts: 0,
      last_error: null,
      response: null,
      synced_at: null,
    };
    await this.store.insert(item);
    this.emit();
    return (await this.store.get(id))!;
  }

  /** Enqueue, then sync, then report what happened to this payload. Used at the end of a run. */
  async submit(payload: TestPayload): Promise<SubmitOutcome> {
    const item = await this.enqueue(payload);
    await this.sync();
    const after = (await this.store.get(item.id))!;
    if (after.state === "synced") return { state: "synced", response: after.response! };
    if (after.state === "failed") {
      const [code, ...msg] = (after.last_error ?? "failed").split(": ");
      return { state: "failed", code, message: msg.join(": ") };
    }
    return { state: "pending", error: after.last_error };
  }

  /** Send every pending item once. Concurrent callers share the same pass, so nothing is posted twice at once. */
  sync(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<SyncReport> {
    const report: SyncReport = { sent: 0, failed: 0, stillPending: 0 };
    const items = await this.store.pending();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const res = await this.api.submitTest(item.payload);
        await this.store.markSynced(item.id, res, this.now().toISOString());
        report.sent++;
      } catch (e) {
        if (e instanceof NetworkError) {
          // Offline again: stop here, keep the rest for the next connection.
          await this.store.noteAttempt(item.id, "no_network");
          report.stillPending += items.length - i;
          break;
        }
        if (e instanceof ApiError && e.retryable) {
          await this.store.noteAttempt(item.id, `${e.code}: ${e.message}`);
          report.stillPending++;
          continue;
        }
        if (e instanceof ApiError) {
          // A definitive answer (schema_violation, bad_signature, nonce_used, ...): never resend.
          await this.store.markFailed(item.id, `${e.code}: ${e.message}`);
          report.failed++;
          continue;
        }
        await this.store.noteAttempt(item.id, e instanceof Error ? e.message : String(e));
        report.stillPending++;
      }
    }
    this.emit();
    return report;
  }
}
