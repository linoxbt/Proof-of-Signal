import * as SQLite from "expo-sqlite";
import type { TestResponse } from "../contracts";
import type { KvStore } from "../protocol/device";
import type { QueueItem, QueueStore } from "../protocol/queue";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const d = await SQLite.openDatabaseAsync("sweep.db");
      await d.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS queue (
          id TEXT PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL,
          pu_code TEXT NOT NULL,
          offline INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','synced','failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          response TEXT,
          synced_at TEXT
        );
        CREATE INDEX IF NOT EXISTS queue_state ON queue (state, created_at);
      `);
      return d;
    })();
  }
  return dbPromise;
}

interface Row {
  id: string;
  created_at: string;
  pu_code: string;
  offline: number;
  payload: string;
  state: QueueItem["state"];
  attempts: number;
  last_error: string | null;
  response: string | null;
  synced_at: string | null;
}

function fromRow(r: Row): QueueItem {
  return {
    id: r.id,
    created_at: r.created_at,
    pu_code: r.pu_code,
    offline: r.offline === 1,
    payload: JSON.parse(r.payload),
    state: r.state,
    attempts: r.attempts,
    last_error: r.last_error,
    response: r.response ? (JSON.parse(r.response) as TestResponse) : null,
    synced_at: r.synced_at,
  };
}

export const sqliteQueue: QueueStore = {
  async insert(i) {
    const d = await db();
    const res = await d.runAsync(
      `INSERT OR IGNORE INTO queue (id, created_at, pu_code, offline, payload, state, attempts, last_error, response, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [i.id, i.created_at, i.pu_code, i.offline ? 1 : 0, JSON.stringify(i.payload), i.state, i.attempts, i.last_error,
        i.response ? JSON.stringify(i.response) : null, i.synced_at],
    );
    return res.changes > 0;
  },
  async get(id) {
    const r = await (await db()).getFirstAsync<Row>("SELECT * FROM queue WHERE id = ?", [id]);
    return r ? fromRow(r) : null;
  },
  async pending() {
    const rows = await (await db()).getAllAsync<Row>("SELECT * FROM queue WHERE state = 'pending' ORDER BY created_at ASC");
    return rows.map(fromRow);
  },
  async list() {
    const rows = await (await db()).getAllAsync<Row>("SELECT * FROM queue ORDER BY created_at DESC LIMIT 500");
    return rows.map(fromRow);
  },
  async markSynced(id, response, at) {
    await (await db()).runAsync(
      "UPDATE queue SET state = 'synced', response = ?, synced_at = ?, last_error = NULL WHERE id = ?",
      [JSON.stringify(response), at, id],
    );
  },
  async markFailed(id, error) {
    await (await db()).runAsync("UPDATE queue SET state = 'failed', last_error = ? WHERE id = ?", [error, id]);
  },
  async noteAttempt(id, error) {
    await (await db()).runAsync("UPDATE queue SET attempts = attempts + 1, last_error = ? WHERE id = ?", [error, id]);
  },
  async clear() {
    await (await db()).runAsync("DELETE FROM queue");
  },
};

export const sqliteKv: KvStore = {
  async get(key) {
    const r = await (await db()).getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    return r?.value ?? null;
  },
  async set(key, value) {
    await (await db()).runAsync("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  },
  async delete(key) {
    await (await db()).runAsync("DELETE FROM kv WHERE key = ?", [key]);
  },
};
