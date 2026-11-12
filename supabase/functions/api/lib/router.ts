// Path routing for the single `api` function.

import { ApiError, clientIp, err, errorResponse, json, withCors } from "./http.ts";
import type { Ctx, Req } from "./context.ts";
import { eraseDevice, issueNonce, registerDevice } from "../handlers/devices.ts";
import { nearby, search } from "../handlers/pus.ts";
import { postTest } from "../handlers/tests.ts";
import { coverage, elections, mapCoverage, mapProgress, method, register } from "../handlers/public.ts";
import { listFlags, nightSummary, nightUnits, reviewFlag } from "../handlers/night.ts";
import { IntegrityUnavailable } from "./integrity.ts";

type Handler = (ctx: Ctx, r: Req) => Promise<Response>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    "^" + path.replace(/\{(\w+)\}/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    }) + "/?$",
  );
  return { method, re, keys, handler };
}

export const routes: Route[] = [
  route("POST", "/v1/devices", registerDevice),
  route("DELETE", "/v1/devices/{id}/data", eraseDevice),
  route("GET", "/v1/nonce", issueNonce),
  route("GET", "/v1/pus/nearby", nearby),
  route("GET", "/v1/pus/search", search),
  route("POST", "/v1/tests", postTest),
  route("GET", "/v1/coverage/{pu_code}", coverage),
  route("GET", "/v1/map/coverage", mapCoverage),
  route("GET", "/v1/map/progress", mapProgress),
  route("GET", "/v1/register", register),
  route("GET", "/v1/elections", elections),
  route("GET", "/v1/night/{election}/summary", nightSummary),
  route("GET", "/v1/night/{election}/units", nightUnits),
  route("GET", "/v1/night/{election}/flags", listFlags),
  route("POST", "/v1/flags/{id}/review", reviewFlag),
  route("GET", "/v1/method", method),
];

/** Strips everything up to and including the `/api` segment (`/functions/v1/api/v1/x` -> `/v1/x`). */
export function stripPrefix(pathname: string): string {
  const m = /(^|\/)api(\/|$)/.exec(pathname);
  if (!m) return pathname;
  const rest = pathname.slice(m.index + m[0].length - (m[2] ? 1 : 0));
  return rest === "" ? "/" : rest;
}

export function createHandler(
  ctx: Ctx,
): (req: Request, info?: { remoteAddr?: { hostname?: string } }) => Promise<Response> {
  return async (req, info) => {
    const method = req.method.toUpperCase();
    if (method === "OPTIONS") {
      const wanted = req.headers.get("access-control-request-method") ?? "GET";
      return withCors(new Response(null, { status: 204 }), wanted, ctx.cfg.dashboardOrigin);
    }
    const url = new URL(req.url);
    const path = stripPrefix(url.pathname);
    let res: Response;
    try {
      let matched: { r: Route; m: RegExpExecArray } | null = null;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (m && (r.method === method || (method === "HEAD" && r.method === "GET"))) {
          matched = { r, m };
          break;
        }
      }
      if (!matched) throw err.notFound(`No route for ${method} ${path}`);
      const params: Record<string, string> = {};
      matched.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(matched!.m[i + 1])));
      res = await matched.r.handler(ctx, {
        req,
        url,
        params,
        ip: clientIp(req, info?.remoteAddr?.hostname ?? "unknown"),
      });
      if (method === "HEAD") res = new Response(null, { status: res.status, headers: res.headers });
    } catch (e) {
      if (e instanceof ApiError) {
        res = errorResponse(e);
      } else {
        console.error(
          e instanceof IntegrityUnavailable ? "integrity service unavailable:" : "internal error:",
          e,
        );
        res = json({ error: { code: "internal", message: "Internal error" } }, 500);
      }
    }
    return withCors(res, method, ctx.cfg.dashboardOrigin);
  };
}
