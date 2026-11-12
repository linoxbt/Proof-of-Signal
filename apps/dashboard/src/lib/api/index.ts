import { API_BASE, MODE } from "../config";
import { createDemoFetch, DEMO_API_BASE } from "../demo/transport";
import { demoStore } from "../demo/store";
import { ApiClient, ApiError, type FetchLike } from "./client";

const notConfigured: FetchLike = async () => {
  throw new ApiError(0, "not_configured", "NEXT_PUBLIC_API_BASE is not set and demo mode is off.");
};

function liveFetch(input: string, init?: RequestInit) {
  return fetch(input, { ...init, credentials: "omit", cache: "no-store" });
}

export const api: ApiClient =
  MODE === "demo"
    ? new ApiClient(DEMO_API_BASE, createDemoFetch(demoStore, { latencyMs: 120 }))
    : MODE === "live"
      ? new ApiClient(API_BASE, liveFetch)
      : new ApiClient("", notConfigured);

export { ApiClient, ApiError };
