import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, buildUrl, type FetchLike } from "@/lib/api/client";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  });
  return { fn, calls };
}

const BASE = "https://ref.supabase.co/functions/v1/api";

describe("buildUrl", () => {
  it("skips empty params and encodes values", () => {
    expect(buildUrl(BASE, "/v1/map/coverage", { state: 99, lga: undefined, q: "" })).toBe(`${BASE}/v1/map/coverage?state=99`);
    expect(buildUrl(BASE, "/v1/pus/search", { q: "a b&c" })).toBe(`${BASE}/v1/pus/search?q=a+b%26c`);
  });
});

describe("ApiClient", () => {
  it("calls the contract paths", async () => {
    const { fn, calls } = mockFetch(200, {});
    const c = new ApiClient(BASE, fn);
    await c.coverage("99-01-01-002");
    await c.mapCoverage(99, 1);
    await c.mapProgress(99);
    await c.register({ state: 99, limit: 500 });
    await c.elections();
    await c.nightSummary("replay-demo");
    await c.nightUnits("replay-demo", 99);
    await c.method();
    expect(calls.map((x) => x.url.replace(BASE, ""))).toEqual([
      "/v1/coverage/99-01-01-002",
      "/v1/map/coverage?state=99&lga=1",
      "/v1/map/progress?state=99",
      "/v1/register?state=99&limit=500&format=json",
      "/v1/elections",
      "/v1/night/replay-demo/summary",
      "/v1/night/replay-demo/units?state=99",
      "/v1/method",
    ]);
    expect(calls.every((x) => !(x.init?.headers as Record<string, string>).authorization)).toBe(true);
  });

  it("sends the Bearer token and filters for reviewer endpoints", async () => {
    const { fn, calls } = mockFetch(200, { flags: [] });
    const c = new ApiClient(BASE, fn);
    await c.flags("replay-demo", { classes: ["UNEXPLAINED_DELAY", "WATCH"], statuses: ["unreviewed", "awaiting_second"] }, "tok");
    expect(calls[0].url).toBe(
      `${BASE}/v1/night/replay-demo/flags?class=UNEXPLAINED_DELAY%2CWATCH&status=unreviewed%2Cawaiting_second`,
    );
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("posts a review with the note and returns the flag", async () => {
    const { fn, calls } = mockFetch(200, { flag: { id: "f1", review_status: "awaiting_second" } });
    const c = new ApiClient(BASE, fn);
    const flag = await c.reviewFlag("f1", "concern_confirmed", "  saw it  ", "tok");
    expect(flag.id).toBe("f1");
    expect(calls[0].url).toBe(`${BASE}/v1/flags/f1/review`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ decision: "concern_confirmed", note: "saw it" });
  });

  it("requires a note for explained before calling the API", async () => {
    const { fn } = mockFetch(200, {});
    const c = new ApiClient(BASE, fn);
    await expect(c.reviewFlag("f1", "explained", "   ", "tok")).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("parses the contract error body and retry-after", async () => {
    const { fn } = mockFetch(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "30" });
    const c = new ApiClient(BASE, fn);
    const err = await c.method().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", message: "slow down", retryAfter: 30 });
  });

  it("copes with a non-JSON error body", async () => {
    const { fn } = mockFetch(502, "<html>bad gateway</html>");
    const err = await new ApiClient(BASE, fn).method().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "http_error" });
  });

  it("wraps network failures", async () => {
    const fn: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const err = await new ApiClient(BASE, fn).method().catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: "network_error" });
  });

  it("builds the CSV download URL", () => {
    const c = new ApiClient(BASE, mockFetch(200, {}).fn);
    expect(c.registerCsvUrl({ state: 99, lga: 2 })).toBe(`${BASE}/v1/register?state=99&lga=2&format=csv`);
  });
});
