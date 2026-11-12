// Typed client for contracts/api.md. The transport is a fetch-compatible
// function: the real `fetch` against NEXT_PUBLIC_API_BASE in live mode, or the
// synthetic demo handler (src/lib/demo/transport.ts) in demo mode.
import type {
  CoverageFeatureProps,
  CoverageResponse,
  ElectionsResponse,
  FeatureCollection,
  Flag,
  FlagClass,
  FlagsResponse,
  MapProgressResponse,
  MethodResponse,
  NightSummary,
  NightUnitProps,
  PuSearchUnit,
  RegisterResponse,
  ReviewDecision,
  ReviewStatus,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface RegisterQuery {
  state?: number;
  lga?: number;
  limit?: number;
}

export interface FlagsQuery {
  classes?: FlagClass[];
  statuses?: ReviewStatus[];
}

type Query = Record<string, string | number | undefined | null>;

export function buildUrl(base: string, path: string, query?: Query): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${base}${path}${s ? `?${s}` : ""}`;
}

async function parseError(res: Response): Promise<ApiError> {
  const retry = res.headers.get("retry-after");
  const retryAfter = retry !== null && retry !== "" && Number.isFinite(Number(retry)) ? Number(retry) : null;
  let code = "http_error";
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error: { code?: unknown; message?: unknown } }).error;
      if (typeof err?.code === "string") code = err.code;
      if (typeof err?.message === "string") message = err.message;
    }
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  return new ApiError(res.status, code, message, retryAfter);
}

export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly fetcher: FetchLike,
  ) {}

  private async request<T>(
    path: string,
    opts: { query?: Query; method?: string; body?: unknown; token?: string | null; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await this.fetcher(buildUrl(this.base, path, opts.query), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError(0, "network_error", e instanceof Error ? e.message : "Network error");
    }
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  coverage(puCode: string, signal?: AbortSignal) {
    return this.request<CoverageResponse>(`/v1/coverage/${encodeURIComponent(puCode)}`, { signal });
  }

  mapCoverage(state: number, lga?: number, signal?: AbortSignal) {
    return this.request<FeatureCollection<CoverageFeatureProps>>("/v1/map/coverage", { query: { state, lga }, signal });
  }

  mapProgress(state: number, signal?: AbortSignal) {
    return this.request<MapProgressResponse>("/v1/map/progress", { query: { state }, signal });
  }

  register(q: RegisterQuery, signal?: AbortSignal) {
    return this.request<RegisterResponse>("/v1/register", {
      query: { state: q.state, lga: q.lga, limit: q.limit, format: "json" },
      signal,
    });
  }

  /** URL of the server-generated CSV (`content-disposition: attachment`). */
  registerCsvUrl(q: RegisterQuery): string {
    return buildUrl(this.base, "/v1/register", { state: q.state, lga: q.lga, limit: q.limit, format: "csv" });
  }

  /** Fetch the server-generated CSV as text (used where a plain link cannot be, e.g. demo mode). */
  async registerCsv(q: RegisterQuery): Promise<string> {
    const res = await this.fetcher(this.registerCsvUrl(q), { method: "GET", headers: { accept: "text/csv" } });
    if (!res.ok) throw await parseError(res);
    return res.text();
  }

  searchUnits(q: string, signal?: AbortSignal) {
    return this.request<{ units: PuSearchUnit[] }>("/v1/pus/search", { query: { q, limit: 10 }, signal });
  }

  elections(signal?: AbortSignal) {
    return this.request<ElectionsResponse>("/v1/elections", { signal });
  }

  nightSummary(election: string, signal?: AbortSignal) {
    return this.request<NightSummary>(`/v1/night/${encodeURIComponent(election)}/summary`, { signal });
  }

  nightUnits(election: string, state?: number, signal?: AbortSignal) {
    return this.request<FeatureCollection<NightUnitProps>>(`/v1/night/${encodeURIComponent(election)}/units`, {
      query: { state },
      signal,
    });
  }

  method(signal?: AbortSignal) {
    return this.request<MethodResponse>("/v1/method", { signal });
  }

  flags(election: string, q: FlagsQuery, token: string, signal?: AbortSignal) {
    return this.request<FlagsResponse>(`/v1/night/${encodeURIComponent(election)}/flags`, {
      query: { class: q.classes?.join(","), status: q.statuses?.join(",") },
      token,
      signal,
    });
  }

  async reviewFlag(id: string, decision: ReviewDecision, note: string, token: string): Promise<Flag> {
    const trimmed = note.trim();
    if (decision === "explained" && !trimmed) {
      throw new ApiError(400, "invalid_body", "A reason is required when marking a flag as explained.");
    }
    const res = await this.request<{ flag: Flag }>(`/v1/flags/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: trimmed ? { decision, note: trimmed } : { decision },
      token,
    });
    return res.flag;
  }
}
