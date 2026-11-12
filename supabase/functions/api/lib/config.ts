// Runtime configuration, read once from the environment.

export type IntegrityMode = "google" | "off";

export interface Config {
  databaseUrl: string;
  jwtSecret: string | null;
  dashboardOrigin: string;
  integrityMode: IntegrityMode;
  allowUnverifiedDevices: boolean;
  playPackageName: string | null;
  googleServiceAccountJson: string | null;
  placeRadiusM: number;
  /** Per-IP limits per hour (in-memory, per isolate). */
  ipLimitDevices: number;
  ipLimitNonce: number;
  ipLimitTests: number;
  /** Per-device nonce limit per hour (database-backed). */
  deviceNonceLimit: number;
  dbPoolMax: number;
}

type Env = { get(key: string): string | undefined };

function num(env: Env, key: string, dflt: number): number {
  const v = env.get(key);
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

export function loadConfig(env: Env = Deno.env): Config {
  const databaseUrl = env.get("SUPABASE_DB_URL") || env.get("DATABASE_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL (or DATABASE_URL) is not set");
  const mode = (env.get("PLAY_INTEGRITY_MODE") || "google").toLowerCase();
  if (mode !== "google" && mode !== "off") {
    throw new Error("PLAY_INTEGRITY_MODE must be google or off");
  }
  const cfg: Config = {
    databaseUrl,
    jwtSecret: env.get("SUPABASE_JWT_SECRET") || null,
    dashboardOrigin: env.get("DASHBOARD_ORIGIN") || "",
    integrityMode: mode,
    allowUnverifiedDevices: env.get("ALLOW_UNVERIFIED_DEVICES") === "true",
    playPackageName: env.get("PLAY_PACKAGE_NAME") || null,
    googleServiceAccountJson: env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || null,
    placeRadiusM: num(env, "PLACE_RADIUS_M", 150),
    ipLimitDevices: num(env, "RATE_IP_DEVICES_PER_HOUR", 20),
    ipLimitNonce: num(env, "RATE_IP_NONCE_PER_HOUR", 300),
    ipLimitTests: num(env, "RATE_IP_TESTS_PER_HOUR", 300),
    deviceNonceLimit: num(env, "RATE_DEVICE_NONCE_PER_HOUR", 30),
    dbPoolMax: num(env, "DB_POOL_MAX", 5),
  };
  if (cfg.integrityMode === "google" && (!cfg.playPackageName || !cfg.googleServiceAccountJson)) {
    throw new Error("PLAY_INTEGRITY_MODE=google needs PLAY_PACKAGE_NAME and GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  return cfg;
}
