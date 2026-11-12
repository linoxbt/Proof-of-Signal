// Runtime mode. NEXT_PUBLIC_* values are inlined at build time.
//
// live          NEXT_PUBLIC_API_BASE is set (and demo is not forced).
// demo          NEXT_PUBLIC_DEMO_MODE=true, or a development build with no API base.
// unconfigured  production build with no API base and demo not enabled: the UI
//               says so instead of silently showing synthetic data.

export type AppMode = "live" | "demo" | "unconfigured";

export interface ModeEnv {
  apiBase?: string;
  demoMode?: string;
  nodeEnv?: string;
}

export function resolveMode(env: ModeEnv): AppMode {
  const demoForced = env.demoMode === "true";
  const apiBase = (env.apiBase ?? "").trim();
  if (demoForced) return "demo";
  if (apiBase) return "live";
  if (env.nodeEnv !== "production") return "demo";
  return "unconfigured";
}

export function normaliseApiBase(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export const API_BASE = normaliseApiBase(process.env.NEXT_PUBLIC_API_BASE);

export const MODE: AppMode = resolveMode({
  apiBase: process.env.NEXT_PUBLIC_API_BASE,
  demoMode: process.env.NEXT_PUBLIC_DEMO_MODE,
  nodeEnv: process.env.NODE_ENV,
});

export const IS_DEMO = MODE === "demo";

/** The synthetic seed uses state code 99, which does not exist in Nigeria. */
export const DEMO_STATE_CODE = 99;

export const DEFAULT_STATE_CODE: number = (() => {
  if (IS_DEMO) return DEMO_STATE_CODE;
  const n = Number(process.env.NEXT_PUBLIC_DEFAULT_STATE);
  return Number.isInteger(n) && n > 0 ? n : DEMO_STATE_CODE;
})();

export const PMTILES_URL = (process.env.NEXT_PUBLIC_PMTILES_URL ?? "").trim();
/** Optional self-hosted glyphs for basemap labels, e.g. https://cdn.example.org/fonts/{fontstack}/{range}.pbf */
export const BASEMAP_GLYPHS_URL = (process.env.NEXT_PUBLIC_BASEMAP_GLYPHS_URL ?? "").trim();

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
export const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
