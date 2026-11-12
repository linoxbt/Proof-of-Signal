// Public read endpoints: coverage, map layers, register, elections, method.

import { CACHE_PUBLIC, err, json } from "../lib/http.ts";
import { type Ctx, intParam, PU_RE, type Req } from "../lib/context.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export async function coverage(ctx: Ctx, r: Req): Promise<Response> {
  const code = r.params.pu_code;
  if (!PU_RE.test(code)) throw err.notFound("Unknown polling unit");
  const sql = ctx.sql;
  const [u] = await sql`
    select pu_code, name, ward, lga, state,
           extensions.st_y(geom::extensions.geometry) as lat,
           extensions.st_x(geom::extensions.geometry) as lng
    from public.polling_units where pu_code = ${code}`;
  if (!u) throw err.notFound("Unknown polling unit");
  const carriers = await sql`
    select mcc::int, mnc::int, carrier, p, p_lo, p_hi, n_tests, n_devices, n_evenings, measured, model_version
    from public.coverage_current where pu_code = ${code} order by mcc, mnc`;
  const [b] = await sql`
    select p_best, p_best_lo, p_best_hi, measured, n_tests from public.coverage_best_carrier where pu_code = ${code}`;
  return json(
    {
      pu_code: u.pu_code,
      name: u.name,
      ward: u.ward,
      lga: u.lga,
      state: u.state,
      lat: u.lat,
      lng: u.lng,
      model_version: carriers[0]?.model_version ?? null,
      best: b ? { p: b.p_best, p_lo: b.p_best_lo, p_hi: b.p_best_hi, measured: b.measured, n_tests: b.n_tests } : null,
      carriers: carriers.map((c: Row) => ({
        mcc: c.mcc,
        mnc: c.mnc,
        carrier: c.carrier,
        p: c.p,
        p_lo: c.p_lo,
        p_hi: c.p_hi,
        n_tests: c.n_tests,
        n_devices: c.n_devices,
        n_evenings: c.n_evenings,
        measured: c.measured,
      })),
    },
    200,
    CACHE_PUBLIC,
  );
}

export async function mapCoverage(ctx: Ctx, r: Req): Promise<Response> {
  const state = intParam(r.url, "state", null, 0, 99);
  if (state === null) throw err.invalidQuery("state is required");
  const lga = intParam(r.url, "lga", null, 0, 99);
  const sql = ctx.sql;
  const rows = await sql`
    select pu.pu_code, pu.name, pu.ward, pu.lga,
           extensions.st_y(pu.geom::extensions.geometry) as lat,
           extensions.st_x(pu.geom::extensions.geometry) as lng,
           b.p_best, b.p_best_lo, b.p_best_hi, b.n_tests, b.measured,
           (select jsonb_object_agg(c.mnc::text, c.p) from public.coverage_current c where c.pu_code = pu.pu_code)
             as carriers
    from public.polling_units pu
    left join public.coverage_best_carrier b on b.pu_code = pu.pu_code
    where pu.state_code = ${state} and pu.geom is not null
      ${lga === null ? sql`` : sql`and pu.lga_code = ${lga}`}
    order by pu.pu_code`;
  return json(
    {
      type: "FeatureCollection",
      features: rows.map((x: Row) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [x.lng, x.lat] },
        properties: {
          pu_code: x.pu_code,
          name: x.name,
          ward: x.ward,
          lga: x.lga,
          p_best: x.p_best ?? null,
          p_lo: x.p_best_lo ?? null,
          p_hi: x.p_best_hi ?? null,
          n_tests: x.n_tests ?? 0,
          measured: x.measured ?? false,
          carriers: Object.fromEntries(Object.entries(x.carriers ?? {}).map(([k, v]) => [k, Number(v)])),
        },
      })),
    },
    200,
    CACHE_PUBLIC,
  );
}

export async function mapProgress(ctx: Ctx, r: Req): Promise<Response> {
  const state = intParam(r.url, "state", null, 0, 99);
  if (state === null) throw err.invalidQuery("state is required");
  const rows = await ctx.sql`
    select pu.lga_code::int, min(pu.lga) as lga, count(*)::int as units,
           count(*) filter (where pr.n_tests > 0)::int as tested,
           count(*) filter (where pr.n_tests >= 3 and pr.n_devices >= 2 and pr.n_evenings >= 2)::int as measured
    from public.polling_units pu
    left join lateral (
      select count(*) as n_tests, count(distinct t.device_id) as n_devices, count(distinct t.local_date) as n_evenings
      from public.tests t
      where t.pu_code = pu.pu_code and t.status = 'accepted' and t.is_evening
    ) pr on true
    where pu.state_code = ${state}
    group by pu.lga_code
    order by pu.lga_code`;
  return json({ lgas: rows }, 200, CACHE_PUBLIC);
}

export function suggestedAction(p: number): string {
  if (p < 0.2) return "satellite or alternate upload point";
  if (p < 0.5) return "alternate upload point or signal booster";
  if (p < 0.8) return "confirm fallback plan";
  return "monitor";
}

export const REGISTER_COLUMNS = [
  "pu_code",
  "name",
  "ward",
  "lga",
  "state",
  "p_best",
  "p_lo",
  "p_hi",
  "n_tests",
  "carriers_seen",
  "suggested_action",
] as const;

export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function register(ctx: Ctx, r: Req): Promise<Response> {
  const state = intParam(r.url, "state", null, 0, 99);
  const lga = intParam(r.url, "lga", null, 0, 99);
  const limit = intParam(r.url, "limit", 500, 1, 10000)!;
  const format = r.url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw err.invalidQuery("format must be json or csv");
  const sql = ctx.sql;
  const [mv] = await sql`select id from public.model_versions where is_current`;
  const rows = await sql`
    select pu.pu_code, pu.name, pu.ward, pu.lga, pu.state,
           b.p_best, b.p_best_lo as p_lo, b.p_best_hi as p_hi, b.n_tests,
           coalesce((
             select string_agg(x.carrier, ';' order by x.carrier)
             from (
               select distinct coalesce(c.name, s.mcc || '-' || s.mnc) as carrier
               from public.tests t
               join public.test_sims s on s.test_id = t.id
               left join public.carriers c on c.mcc = s.mcc and c.mnc = s.mnc
               where t.pu_code = pu.pu_code and t.status = 'accepted'
             ) x
           ), '') as carriers_seen
    from public.coverage_best_carrier b
    join public.polling_units pu on pu.pu_code = b.pu_code
    where true
      ${state === null ? sql`` : sql`and pu.state_code = ${state}`}
      ${lga === null ? sql`` : sql`and pu.lga_code = ${lga}`}
    order by b.p_best asc, pu.pu_code
    limit ${limit}`;
  const out = rows.map((x: Row) => ({
    pu_code: x.pu_code,
    name: x.name,
    ward: x.ward,
    lga: x.lga,
    state: x.state,
    p_best: x.p_best,
    p_lo: x.p_lo,
    p_hi: x.p_hi,
    n_tests: x.n_tests,
    carriers_seen: x.carriers_seen,
    suggested_action: suggestedAction(x.p_best),
  }));
  if (format === "csv") {
    const lines = [REGISTER_COLUMNS.join(",")];
    for (const row of out) lines.push(REGISTER_COLUMNS.map((c) => csvField(row[c])).join(","));
    const name = `risk-register${state === null ? "" : `-${String(state).padStart(2, "0")}`}${
      lga === null ? "" : `-${String(lga).padStart(2, "0")}`
    }.csv`;
    return new Response(lines.join("\r\n") + "\r\n", {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": CACHE_PUBLIC,
      },
    });
  }
  return json({ model_version: mv?.id ?? null, rows: out }, 200, CACHE_PUBLIC);
}

export async function elections(ctx: Ctx, _r: Req): Promise<Response> {
  const rows = await ctx.sql`
    select e.id, e.name, e.election_date::text, e.state_codes::int[] as state_codes, e.polls_close_at, e.is_replay,
           s.id as s_id, encode(s.sha256, 'hex') as s_sha256, s.frozen_at as s_frozen_at,
           s.model_version as s_model_version, s.tsa_at as s_tsa_at
    from public.elections e
    left join public.snapshots s on s.id = e.snapshot_id
    order by e.election_date desc, e.id`;
  return json(
    {
      elections: rows.map((e: Row) => ({
        id: e.id,
        name: e.name,
        election_date: e.election_date,
        state_codes: e.state_codes,
        polls_close_at: iso(e.polls_close_at),
        is_replay: e.is_replay,
        snapshot: e.s_id
          ? {
            id: e.s_id,
            sha256: e.s_sha256,
            frozen_at: iso(e.s_frozen_at),
            model_version: e.s_model_version,
            tsa_at: iso(e.s_tsa_at),
          }
          : null,
      })),
    },
    200,
    CACHE_PUBLIC,
  );
}

export async function method(ctx: Ctx, _r: Req): Promise<Response> {
  const sql = ctx.sql;
  const models = await sql`
    select id, trained_at, metrics, is_current from public.model_versions order by trained_at desc`;
  const snaps = await sql`
    select id, election_id, model_version, frozen_at, encode(sha256, 'hex') as sha256, row_count, tsa_at
    from public.snapshots where sha256 is not null order by frozen_at desc`;
  const roots = await sql`
    select day::text, encode(root_hash, 'hex') as root_hash, tsa_at
    from public.audit_roots order by day desc limit 400`;
  return json(
    {
      model_versions: models.map((m: Row) => ({ ...m, trained_at: iso(m.trained_at) })),
      snapshots: snaps.map((s: Row) => ({ ...s, frozen_at: iso(s.frozen_at), tsa_at: iso(s.tsa_at) })),
      audit_roots: roots.map((a: Row) => ({ ...a, tsa_at: iso(a.tsa_at) })),
    },
    200,
    CACHE_PUBLIC,
  );
}
