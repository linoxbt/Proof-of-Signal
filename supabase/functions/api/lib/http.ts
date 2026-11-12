// Responses, the contract's error shape, and CORS.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const err = {
  invalidBody: (m = "Request body is not valid") => new ApiError(400, "invalid_body", m),
  invalidQuery: (m = "Query parameters are not valid") => new ApiError(400, "invalid_query", m),
  schema: (m: string) => new ApiError(400, "schema_violation", m),
  badSignature: (m = "Signature does not verify") => new ApiError(401, "bad_signature", m),
  unauthenticated: (m = "A valid bearer token is required") => new ApiError(401, "unauthenticated", m),
  quarantined: () => new ApiError(403, "device_quarantined", "This device is quarantined"),
  banned: () => new ApiError(403, "device_banned", "This device is banned"),
  forbidden: (m = "Not allowed") => new ApiError(403, "forbidden", m),
  notFound: (m = "Not found") => new ApiError(404, "not_found", m),
  unknownNonce: () => new ApiError(404, "unknown_nonce", "Nonce was not issued to this device"),
  nonceUsed: () => new ApiError(409, "nonce_used", "Nonce was already used"),
  nonceExpired: () => new ApiError(410, "nonce_expired", "Nonce is older than 7 days"),
  rateLimited: (retryAfterS: number) =>
    new ApiError(429, "rate_limited", "Too many requests", {
      "retry-after": String(Math.max(1, Math.ceil(retryAfterS))),
    }),
};

export const CACHE_PUBLIC = "public, max-age=60";
export const CACHE_NIGHT = "public, max-age=15";
export const CACHE_NONE = "no-store";
export const CACHE_PRIVATE = "private, no-store";

export function json(body: unknown, status = 200, cache = CACHE_NONE, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, ...extra },
  });
}

export function errorResponse(e: ApiError): Response {
  return json({ error: { code: e.code, message: e.message } }, e.status, CACHE_NONE, e.headers);
}

const ALLOW_HEADERS = "authorization, content-type, apikey, x-client-info";
const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";

/** GET endpoints allow any origin; others allow only DASHBOARD_ORIGIN. */
export function corsHeaders(method: string, dashboardOrigin: string): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-headers": ALLOW_HEADERS,
    "access-control-allow-methods": ALLOW_METHODS,
    "access-control-max-age": "86400",
    "access-control-expose-headers": "retry-after, content-disposition",
  };
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    h["access-control-allow-origin"] = "*";
  } else if (dashboardOrigin) {
    h["access-control-allow-origin"] = dashboardOrigin;
    h["vary"] = "origin";
  }
  return h;
}

export function withCors(res: Response, method: string, dashboardOrigin: string): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(method, dashboardOrigin))) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const MAX_BODY = 256 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw err.invalidBody("Body too large");
  if (!text) throw err.invalidBody("Body is empty");
  try {
    return JSON.parse(text);
  } catch {
    throw err.invalidBody("Body is not valid JSON");
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function clientIp(req: Request, fallback = "unknown"): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? fallback;
}
