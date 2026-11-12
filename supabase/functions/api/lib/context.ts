import type { Config } from "./config.ts";
import type { Sql } from "./db.ts";
import type { IntegrityVerifier } from "./integrity.ts";
import { RateLimiter } from "./ratelimit.ts";
import { err } from "./http.ts";

export interface Ctx {
  cfg: Config;
  sql: Sql;
  integrity: IntegrityVerifier;
  limiter: RateLimiter;
}

export interface Req {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
}

/** Throws 429 when `key` is over `limit` per hour on this isolate. */
export function limitIp(ctx: Ctx, r: Req, bucket: string, limit: number) {
  const wait = ctx.limiter.hit(`${bucket}:${r.ip}`, limit);
  if (wait > 0) throw err.rateLimited(wait);
}

export interface Progress {
  n_tests: number;
  n_devices: number;
  n_evenings: number;
  measured: boolean;
  needed: number;
}

/** Progress from counts of accepted evening tests at a unit, all carriers together. */
export function progress(n_tests: number, n_devices: number, n_evenings: number): Progress {
  return {
    n_tests,
    n_devices,
    n_evenings,
    measured: n_tests >= 3 && n_devices >= 2 && n_evenings >= 2,
    needed: Math.max(0, 3 - n_tests),
  };
}

export async function progressFor(sql: Sql, puCode: string): Promise<Progress> {
  const [p] = await sql`
    select count(*)::int as n_tests,
           count(distinct device_id)::int as n_devices,
           count(distinct local_date)::int as n_evenings
    from public.tests
    where pu_code = ${puCode} and status = 'accepted' and is_evening`;
  return progress(p.n_tests, p.n_devices, p.n_evenings);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PU_RE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

/** Parses an integer query parameter; throws invalid_query when malformed or out of range. */
export function intParam(url: URL, name: string, dflt: number | null, min: number, max: number): number | null {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return dflt;
  if (!/^-?\d+$/.test(v)) throw err.invalidQuery(`${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw err.invalidQuery(`${name} must be between ${min} and ${max}`);
  return n;
}

export function numParam(url: URL, name: string, min: number, max: number): number {
  const v = url.searchParams.get(name);
  if (v === null || v.trim() === "") throw err.invalidQuery(`${name} is required`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw err.invalidQuery(`${name} must be a number in [${min}, ${max}]`);
  return n;
}
