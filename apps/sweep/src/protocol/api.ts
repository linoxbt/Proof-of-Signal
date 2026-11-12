import type { ApiErrorBody, NearbyUnit, TestPayload, TestResponse } from "../contracts";
import type { ApiPort, NonceResponse } from "./ports";

/** The server answered with a non-2xx status (contracts/api.md "Errors"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Worth trying again later with the same body: server trouble or rate limiting. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

/** No answer at all: no connection, DNS failure, timeout. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class HttpApi implements ApiPort {
  constructor(
    private readonly base: string,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly timeoutMs = 30000,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base.replace(/\/$/, "") + path, {
        method,
        headers: body === undefined ? { accept: "application/json" } : {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as ApiErrorBody | null)?.error;
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? text.slice(0, 200), Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return json as T;
  }

  registerDevice(body: { pubkey: string; integrity_token: string; app_version: string }) {
    return this.request<{ device_id: string; status: string; integrity_level: string }>("POST", "/v1/devices", body);
  }

  nonce(deviceId: string) {
    return this.request<NonceResponse>("GET", `/v1/nonce?device_id=${encodeURIComponent(deviceId)}`);
  }

  submitTest(payload: TestPayload) {
    return this.request<TestResponse>("POST", "/v1/tests", payload);
  }

  eraseDeviceData(deviceId: string, body: { ts: string; sig: string }) {
    return this.request<{ tests_deleted: number }>("DELETE", `/v1/devices/${encodeURIComponent(deviceId)}/data`, body);
  }

  async nearby(lat: number, lng: number, radiusM: number, limit: number): Promise<NearbyUnit[]> {
    const r = await this.request<{ units: NearbyUnit[] }>(
      "GET",
      `/v1/pus/nearby?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&r=${Math.round(radiusM)}&limit=${limit}`,
    );
    return r.units;
  }

  async search(q: string, limit: number): Promise<NearbyUnit[]> {
    const r = await this.request<{ units: NearbyUnit[] }>(
      "GET",
      `/v1/pus/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    return r.units;
  }
}
