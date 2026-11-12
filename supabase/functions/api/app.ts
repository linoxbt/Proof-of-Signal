// Builds the request handler from a Config. Separate from index.ts so tests
// can construct it with their own config, database and integrity verifier.

import { type Config, loadConfig } from "./lib/config.ts";
import { connect } from "./lib/db.ts";
import { type IntegrityVerifier, makeVerifier } from "./lib/integrity.ts";
import { RateLimiter } from "./lib/ratelimit.ts";
import { createHandler } from "./lib/router.ts";
import { AccessTokenVerifier } from "./lib/jwt.ts";
import type { Ctx } from "./lib/context.ts";

export interface App {
  ctx: Ctx;
  handler: ReturnType<typeof createHandler>;
  close(): Promise<void>;
}

export function createApp(
  cfg: Config = loadConfig(),
  integrity?: IntegrityVerifier,
  tokens?: AccessTokenVerifier,
): App {
  const ctx: Ctx = {
    cfg,
    sql: connect(cfg.databaseUrl, cfg.dbPoolMax),
    integrity: integrity ?? makeVerifier(cfg),
    limiter: new RateLimiter(),
    tokens: tokens ??
      new AccessTokenVerifier({ secret: cfg.jwtSecret, supabaseUrl: cfg.supabaseUrl, issuer: cfg.jwtIssuer }),
  };
  return { ctx, handler: createHandler(ctx), close: () => ctx.sql.end({ timeout: 5 }) };
}
