// Postgres access with porsager/postgres. Device and public endpoints use the
// connection's own role (service role, bypasses RLS). Reviewer endpoints run
// inside a transaction as `authenticated` with the JWT claims set, so RLS and
// has_role() decide what the user sees.

import postgres from "postgres";
import type { JwtClaims } from "./jwt.ts";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

const toNumber = { serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) };

export function connect(url: string, max = 5): Sql {
  return postgres(url, {
    max,
    prepare: false, // Supabase's transaction pooler does not support prepared statements
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: {
      // numeric and bigint come back as JS numbers (values here are small).
      numeric: { to: 1700, from: [1700], ...toNumber },
      int8: { to: 20, from: [20], ...toNumber },
      // deno-lint-ignore no-explicit-any
    } as any,
  });
}

/** Runs `fn` as the signed-in user: `set local role authenticated` plus the JWT claim settings. */
export async function asUser<T>(sql: Sql, claims: JwtClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                    set_config('request.jwt.claim.sub', ${claims.sub}, true),
                    set_config('request.jwt.claim.role', 'authenticated', true)`;
    return await fn(tx);
  }) as T;
}

/** Runs `fn` as `anon`: public night endpoints read only what the public may read. */
export async function asAnon<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`set local role anon`;
    return await fn(tx);
  }) as T;
}

/** Postgres SQLSTATE of an error from postgres.js, if any. */
export function pgCode(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}
