// GET /v1/pus/nearby, GET /v1/pus/search

import { CACHE_PUBLIC, err, json } from "../lib/http.ts";
import { type Ctx, intParam, numParam, progress, type Req } from "../lib/context.ts";
import type { Sql } from "../lib/db.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

function progressJoin(sql: Sql) {
  return sql`
    left join lateral (
      select count(*)::int as n_tests,
             count(distinct t.device_id)::int as n_devices,
             count(distinct t.local_date)::int as n_evenings
      from public.tests t
      where t.pu_code = pu.pu_code and t.status = 'accepted' and t.is_evening
    ) pr on true`;
}

function unit(row: Row, withDist: boolean) {
  const u: Record<string, unknown> = {
    pu_code: row.pu_code,
    name: row.name,
    ward: row.ward,
    lga: row.lga,
    state: row.state,
    lat: row.lat,
    lng: row.lng,
    geom_source: row.geom_source,
  };
  if (withDist) u.dist_m = Math.round(row.dist_m);
  u.progress = progress(row.n_tests, row.n_devices, row.n_evenings);
  return u;
}

export async function nearby(ctx: Ctx, r: Req): Promise<Response> {
  const lat = numParam(r.url, "lat", -90, 90);
  const lng = numParam(r.url, "lng", -180, 180);
  const radius = intParam(r.url, "r", 2000, 1, 10000)!;
  const limit = intParam(r.url, "limit", 5, 1, 20)!;
  const sql = ctx.sql;
  const pt =
    sql`extensions.st_setsrid(extensions.st_makepoint(${lng}::float8, ${lat}::float8), 4326)::extensions.geography`;
  const rows = await sql`
    select pu.pu_code, pu.name, pu.ward, pu.lga, pu.state, pu.geom_source,
           extensions.st_y(pu.geom::extensions.geometry) as lat,
           extensions.st_x(pu.geom::extensions.geometry) as lng,
           extensions.st_distance(pu.geom, ${pt})::float8 as dist_m,
           pr.n_tests, pr.n_devices, pr.n_evenings
    from (
      select * from public.polling_units
      where geom is not null and extensions.st_dwithin(geom, ${pt}, ${radius}::float8)
      order by geom operator(extensions.<->) ${pt}
      limit ${limit}
    ) pu
    ${progressJoin(sql)}
    order by dist_m`;
  return json({ units: rows.map((x: Row) => unit(x, true)) }, 200, CACHE_PUBLIC);
}

export async function search(ctx: Ctx, r: Req): Promise<Response> {
  const q = (r.url.searchParams.get("q") ?? "").trim();
  if (q.length < 1 || q.length > 100) throw err.invalidQuery("q must be 1 to 100 characters");
  const limit = intParam(r.url, "limit", 10, 1, 50)!;
  const like = q.replace(/[\\%_]/g, (c) => "\\" + c);
  const sql = ctx.sql;
  const rows = await sql`
    select pu.pu_code, pu.name, pu.ward, pu.lga, pu.state, pu.geom_source,
           extensions.st_y(pu.geom::extensions.geometry) as lat,
           extensions.st_x(pu.geom::extensions.geometry) as lng,
           pr.n_tests, pr.n_devices, pr.n_evenings
    from (
      select * from public.polling_units
      where pu_code like ${like + "%"} or name ilike ${"%" + like + "%"}
      order by (pu_code like ${like + "%"}) desc, pu_code
      limit ${limit}
    ) pu
    ${progressJoin(sql)}
    order by (pu.pu_code like ${like + "%"}) desc, pu.pu_code`;
  return json({ units: rows.map((x: Row) => unit(x, false)) }, 200, CACHE_PUBLIC);
}
