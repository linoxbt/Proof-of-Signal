// Demo transport: answers the same requests as the real API (contracts/api.md)
// from the synthetic fixtures, as fetch Responses, so the API client and every
// page run unchanged in demo mode.
import type { Flag, FlagClass, NightUnitProps, ReviewDecision, ReviewStatus } from "../api/types";
import type { FetchLike } from "../api/client";
import { registerToCsv } from "../csv";
import {
  DEMO_ELECTION,
  DEMO_ELECTION_ID,
  DEMO_METHOD,
  classifyAll,
  demoCoverage,
  demoEvidence,
  demoFlagId,
  demoMapCoverage,
  demoMapProgress,
  demoNightSummary,
  demoNightUnits,
  demoRegister,
  demoSearch,
  minutesToIso,
} from "./fixtures";
import { DEMO_REVIEWERS, type DemoReview, type DemoStore } from "./store";

export const DEMO_API_BASE = "https://demo.invalid/api";

const FLAG_CLASSES: FlagClass[] = ["HELD_SYSTEM_STALL", "NOT_MEASURED", "PLAUSIBLE_NETWORK", "UNEXPLAINED_DELAY", "WATCH"];
const REVIEW_STATUSES: ReviewStatus[] = ["unreviewed", "awaiting_second", "concern_confirmed", "explained", "dismissed"];
const DECISIONS: ReviewDecision[] = ["concern_confirmed", "explained", "dismissed"];

function json(body: unknown, status = 200, maxAge = 60): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function intParam(v: string | null): number | undefined | "invalid" {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : "invalid";
}

/** Same rule as the apply_flag_review() trigger: two different reviewers to confirm a concern. */
export function reviewStatusFrom(reviews: DemoReview[]): ReviewStatus {
  if (!reviews.length) return "unreviewed";
  const last = reviews[reviews.length - 1];
  if (last.decision === "concern_confirmed") {
    const confirms = new Set(reviews.filter((r) => r.decision === "concern_confirmed").map((r) => r.reviewer_id)).size;
    return confirms >= 2 ? "concern_confirmed" : "awaiting_second";
  }
  return last.decision;
}

function buildFlags(store: DemoStore): Flag[] {
  const t = store.getMinutes();
  return classifyAll(t)
    .map((c) => {
      const id = demoFlagId(c.unit.pu_code);
      const reviews = store.reviews.get(id) ?? [];
      const evidence = demoEvidence(c, t);
      const updated = reviews.length ? reviews[reviews.length - 1].created_at : minutesToIso(c.since_min);
      return {
        id,
        pu_code: c.unit.pu_code,
        class: c.cls,
        p_network: evidence.p_network,
        p_other: evidence.p_other,
        review_status: reviewStatusFrom(reviews),
        note: reviews.length ? reviews[reviews.length - 1].note : null,
        created_at: minutesToIso(c.since_min),
        updated_at: updated,
        resolved_at: null,
        evidence,
        reviews: reviews.map((r) => ({ ...r })),
      } satisfies Flag;
    })
    .sort((a, b) => b.evidence.minutes_pending - a.evidence.minutes_pending || (b.p_other ?? 0) - (a.p_other ?? 0));
}

function outcomeFor(store: DemoStore) {
  return (puCode: string): NightUnitProps["review_outcome"] => {
    const status = reviewStatusFrom(store.reviews.get(demoFlagId(puCode)) ?? []);
    if (status === "explained") return "explained";
    if (status === "concern_confirmed") return "concern_raised";
    return null;
  };
}

function reviewerFor(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  return DEMO_REVIEWERS.find((r) => r.token === m[1].trim()) ?? null;
}

export interface DemoFetchOptions {
  /** Simulated network latency in ms (0 in tests). */
  latencyMs?: number;
}

export function createDemoFetch(store: DemoStore, opts: DemoFetchOptions = {}): FetchLike {
  return async (input, init) => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (!url.href.startsWith(DEMO_API_BASE)) return error(404, "not_found", "Unknown host");
    const path = url.pathname.replace(/^\/api/, "");
    const q = url.searchParams;
    const method = req.method.toUpperCase();
    let m: RegExpExecArray | null;

    if (method === "GET") {
      if ((m = /^\/v1\/coverage\/([^/]+)$/.exec(path))) {
        const c = demoCoverage(decodeURIComponent(m[1]));
        return c ? json(c) : error(404, "not_found", "Unknown polling unit");
      }
      if (path === "/v1/map/coverage") {
        const state = intParam(q.get("state"));
        const lga = intParam(q.get("lga"));
        if (state === undefined || state === "invalid" || lga === "invalid") return error(400, "invalid_query", "state is required");
        return json(demoMapCoverage(state, lga));
      }
      if (path === "/v1/map/progress") {
        const state = intParam(q.get("state"));
        if (state === undefined || state === "invalid") return error(400, "invalid_query", "state is required");
        return json(demoMapProgress(state));
      }
      if (path === "/v1/register") {
        const state = intParam(q.get("state"));
        const lga = intParam(q.get("lga"));
        const limit = intParam(q.get("limit"));
        if (state === "invalid" || lga === "invalid" || limit === "invalid") return error(400, "invalid_query", "Bad number");
        const format = q.get("format") ?? "json";
        const reg = demoRegister({ state, lga, limit });
        if (format === "csv") {
          return new Response(registerToCsv(reg.rows), {
            status: 200,
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="transmission-risk-register-synthetic-demo.csv"',
            },
          });
        }
        if (format !== "json") return error(400, "invalid_query", "format must be json or csv");
        return json(reg);
      }
      if (path === "/v1/pus/search") {
        const limit = intParam(q.get("limit"));
        return json(demoSearch(q.get("q") ?? "", limit === "invalid" ? 10 : limit));
      }
      if (path === "/v1/elections") return json({ elections: [DEMO_ELECTION] });
      if (path === "/v1/method") return json(DEMO_METHOD);

      if ((m = /^\/v1\/night\/([^/]+)\/(summary|units|flags)$/.exec(path))) {
        const election = decodeURIComponent(m[1]);
        if (election !== DEMO_ELECTION_ID) return error(404, "not_found", "Unknown election");
        const t = store.getMinutes();
        if (m[2] === "summary") return json(demoNightSummary(t), 200, 15);
        if (m[2] === "units") {
          const state = intParam(q.get("state"));
          if (state === "invalid") return error(400, "invalid_query", "Bad state");
          const fc = demoNightUnits(t, outcomeFor(store));
          return json(state === undefined || state === 99 ? fc : { type: "FeatureCollection", features: [] }, 200, 15);
        }
        // flags (reviewer)
        if (!req.headers.get("authorization")) return error(401, "unauthenticated", "Sign in required");
        const reviewer = reviewerFor(req);
        if (!reviewer) return error(401, "unauthenticated", "Invalid session");
        const classes = (q.get("class") ?? "").split(",").filter(Boolean);
        const statuses = (q.get("status") ?? "").split(",").filter(Boolean);
        if (classes.some((c) => !FLAG_CLASSES.includes(c as FlagClass)) || statuses.some((s) => !REVIEW_STATUSES.includes(s as ReviewStatus))) {
          return error(400, "invalid_query", "Unknown class or status");
        }
        const flags = buildFlags(store).filter(
          (f) => (!classes.length || classes.includes(f.class)) && (!statuses.length || statuses.includes(f.review_status)),
        );
        return json({ flags }, 200, 0);
      }
    }

    if (method === "POST" && (m = /^\/v1\/flags\/([^/]+)\/review$/.exec(path))) {
      if (!req.headers.get("authorization")) return error(401, "unauthenticated", "Sign in required");
      const reviewer = reviewerFor(req);
      if (!reviewer) return error(403, "forbidden", "Not a reviewer");
      let body: { decision?: unknown; note?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return error(400, "invalid_body", "Body must be JSON");
      }
      const decision = body.decision as ReviewDecision;
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!DECISIONS.includes(decision)) return error(400, "invalid_body", "Unknown decision");
      if (decision === "explained" && !note) return error(400, "invalid_body", "note is required for explained");
      const id = decodeURIComponent(m[1]);
      const flag = buildFlags(store).find((f) => f.id === id);
      if (!flag) return error(404, "not_found", "Unknown flag");
      if ((store.reviews.get(id) ?? []).some((r) => r.reviewer_id === reviewer.id)) {
        return error(409, "already_reviewed", "You have already reviewed this flag. A second reviewer must decide.");
      }
      store.addReview(id, {
        reviewer_id: reviewer.id,
        decision,
        note: note || null,
        created_at: new Date().toISOString(),
      });
      const updated = buildFlags(store).find((f) => f.id === id)!;
      return json({ flag: updated }, 200, 0);
    }

    return error(404, "not_found", `No route for ${method} ${path}`);
  };
}
