// Election night: public summary and unit map (run as `anon`), and the
// reviewer queue and review action (run as the signed-in user, RLS decides).

import { ApiError, CACHE_NIGHT, CACHE_PRIVATE, err, isObject, json, readJson } from "../lib/http.ts";
import { type Ctx, intParam, type Req, UUID_RE } from "../lib/context.ts";
import { asAnon, asUser, pgCode, type Tx } from "../lib/db.ts";
import { type JwtClaims, verifyHs256 } from "../lib/jwt.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

export const STALL_BANNER = "Uploads paused system-wide: the cause is not field network coverage";
const iso = (d: Date | string | null) => (d === null || d === undefined ? null : new Date(d).toISOString());

async function loadElection(tx: Tx, id: string) {
  const [e] = await tx`
    select id, polls_close_at, state_codes::int[] as state_codes from public.elections where id = ${id}`;
  if (!e) throw err.notFound("Unknown election");
  return e;
}

export async function nightSummary(ctx: Ctx, r: Req): Promise<Response> {
  const body = await asAnon(ctx.sql, async (tx) => {
    const e = await loadElection(tx, r.params.election);
    const states = await tx`
      select pu.state_code::int, min(pu.state) as state, count(*)::int as units,
             count(*) filter (where i.state = 'uploaded')::int as uploaded,
             count(*) filter (where coalesce(i.state, 'pending') = 'pending')::int as pending,
             count(*) filter (where i.state = 'cancelled')::int as cancelled
      from public.polling_units pu
      left join public.irev_status i on i.election_id = ${e.id} and i.pu_code = pu.pu_code
      where pu.state_code = any(string_to_array(${e.state_codes.join(",")}::text, ',')::smallint[])
      group by pu.state_code
      order by pu.state_code`;
    const [stall] = await tx`
      select started_at from public.stall_events
      where election_id = ${e.id} and ended_at is null
      order by started_at desc limit 1`;
    const [t] = await tx`
      select now() as now,
             greatest((select max(fetched_at) from public.irev_status where election_id = ${e.id}),
                      (select max(coalesce(ended_at, started_at)) from public.stall_events where election_id = ${e.id}))
               as updated_at`;
    const totals = { units: 0, uploaded: 0, pending: 0, cancelled: 0 };
    for (const s of states) {
      totals.units += s.units;
      totals.uploaded += s.uploaded;
      totals.pending += s.pending;
      totals.cancelled += s.cancelled;
    }
    return {
      election_id: e.id,
      polls_close_at: iso(e.polls_close_at),
      minutes_since_close: Math.floor((new Date(t.now).getTime() - new Date(e.polls_close_at).getTime()) / 60000),
      system_stall: stall
        ? { active: true, since: iso(stall.started_at), banner: STALL_BANNER }
        : { active: false, since: null, banner: null },
      totals,
      states,
      updated_at: iso(t.updated_at ?? t.now),
    };
  });
  return json(body, 200, CACHE_NIGHT);
}

export async function nightUnits(ctx: Ctx, r: Req): Promise<Response> {
  const state = intParam(r.url, "state", null, 0, 99);
  const rows = await asAnon(ctx.sql, async (tx) => {
    const e = await loadElection(tx, r.params.election);
    // Only the public view of flags (bucket, review outcome) is read here.
    return await tx`
      select pu.pu_code, pu.name, pu.ward, pu.lga,
             extensions.st_y(pu.geom::extensions.geometry) as lat,
             extensions.st_x(pu.geom::extensions.geometry) as lng,
             coalesce(i.state::text, 'pending') as irev_state, i.first_seen_at,
             case when i.state = 'uploaded' then 'uploaded' else coalesce(s.bucket, 'pending') end as bucket,
             s.review_outcome
      from public.polling_units pu
      left join public.irev_status i on i.election_id = ${e.id} and i.pu_code = pu.pu_code
      left join public.public_unit_status s on s.election_id = ${e.id} and s.pu_code = pu.pu_code
      where pu.state_code = any(string_to_array(${
      e.state_codes.join(",")
    }::text, ',')::smallint[]) and pu.geom is not null
        and coalesce(i.state::text, 'pending') <> 'cancelled'
        ${state === null ? tx`` : tx`and pu.state_code = ${state}`}
      order by pu.pu_code`;
  });
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
          irev_state: x.irev_state,
          first_seen_at: iso(x.first_seen_at),
          bucket: x.bucket,
          review_outcome: x.review_outcome ?? null,
        },
      })),
    },
    200,
    CACHE_NIGHT,
  );
}

// ---- Reviewer endpoints ----

export async function authenticate(ctx: Ctx, req: Request): Promise<JwtClaims> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw err.unauthenticated();
  if (!ctx.cfg.jwtSecret) {
    console.error("SUPABASE_JWT_SECRET is not set: reviewer endpoints cannot verify tokens");
    throw err.unauthenticated("Token verification is not configured");
  }
  const claims = await verifyHs256(m[1], ctx.cfg.jwtSecret);
  if (!claims) throw err.unauthenticated("Invalid or expired token");
  return claims;
}

const FLAG_CLASSES = ["HELD_SYSTEM_STALL", "NOT_MEASURED", "PLAUSIBLE_NETWORK", "UNEXPLAINED_DELAY", "WATCH"];
const REVIEW_STATUSES = ["unreviewed", "awaiting_second", "concern_confirmed", "explained", "dismissed"];
const DECISIONS = ["concern_confirmed", "explained", "dismissed"];

function listParam(url: URL, name: string, allowed: string[]): string[] | null {
  const v = url.searchParams.get(name);
  if (v === null || v.trim() === "") return null;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i)) throw err.invalidQuery(`${name}: unknown value ${i}`);
  return items;
}

function flagSelect(tx: Tx) {
  return tx`
    select f.id, f.pu_code, f.class, f.p_network::float8, f.p_other::float8, f.review_status, f.note,
           f.created_at, f.updated_at, f.resolved_at, f.evidence,
           coalesce((
             select jsonb_agg(jsonb_build_object('reviewer_id', fr.reviewer_id, 'decision', fr.decision,
                                                 'note', fr.note, 'created_at', fr.created_at)
                              order by fr.created_at, fr.id)
             from public.flag_reviews fr where fr.flag_id = f.id
           ), '[]'::jsonb) as reviews
    from public.flags f`;
}

function flagOut(f: Row) {
  return {
    id: f.id,
    pu_code: f.pu_code,
    class: f.class,
    p_network: f.p_network,
    p_other: f.p_other,
    review_status: f.review_status,
    note: f.note,
    created_at: iso(f.created_at),
    updated_at: iso(f.updated_at),
    resolved_at: iso(f.resolved_at),
    evidence: f.evidence,
    reviews: (f.reviews as Row[]).map((x) => ({ ...x, created_at: iso(x.created_at) })),
  };
}

export async function listFlags(ctx: Ctx, r: Req): Promise<Response> {
  const claims = await authenticate(ctx, r.req);
  const classes = listParam(r.url, "class", FLAG_CLASSES);
  const statuses = listParam(r.url, "status", REVIEW_STATUSES);
  const rows = await asUser(ctx.sql, claims, async (tx) => {
    await loadElection(tx, r.params.election);
    return await tx`
      ${flagSelect(tx)}
      where f.election_id = ${r.params.election}
        ${classes ? tx`and f.class::text = any(string_to_array(${classes.join(",")}::text, ','))` : tx``}
        ${statuses ? tx`and f.review_status::text = any(string_to_array(${statuses.join(",")}::text, ','))` : tx``}
      order by (f.evidence ->> 'minutes_pending')::float8 desc nulls last, f.created_at, f.id`;
  });
  return json({ flags: rows.map(flagOut) }, 200, CACHE_PRIVATE);
}

export async function reviewFlag(ctx: Ctx, r: Req): Promise<Response> {
  const claims = await authenticate(ctx, r.req);
  const id = r.params.id;
  const body = await readJson(r.req);
  if (!isObject(body) || typeof body.decision !== "string" || !DECISIONS.includes(body.decision)) {
    throw err.invalidBody("decision must be concern_confirmed, explained or dismissed");
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    throw err.invalidBody("note must be a string");
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if (body.decision === "explained" && !note) throw err.invalidBody("note is required for explained");
  if (note && note.length > 4000) throw err.invalidBody("note is too long");
  try {
    const flag = await asUser(ctx.sql, claims, async (tx) => {
      const [role] = await tx`select public.has_role('reviewer') as ok`;
      if (!role.ok) throw err.forbidden("Only accredited reviewers can review flags");
      if (!UUID_RE.test(id)) throw err.notFound("Unknown flag");
      const [f] = await tx`select id from public.flags where id = ${id}`;
      if (!f) throw err.notFound("Unknown flag");
      const [dup] = await tx`
        select 1 from public.flag_reviews where flag_id = ${id} and reviewer_id = auth.uid()`;
      if (dup) throw alreadyReviewed();
      await tx`insert into public.flag_reviews (flag_id, decision, note)
               values (${id}, ${body.decision as string}::public.review_decision, ${note})`;
      const [out] = await tx`${flagSelect(tx)} where f.id = ${id}`;
      return out;
    });
    return json({ flag: flagOut(flag) }, 200, CACHE_PRIVATE);
  } catch (e) {
    const code = pgCode(e);
    if (code === "23505") throw alreadyReviewed();
    if (code === "42501") throw err.forbidden("Only accredited reviewers can review flags");
    if (code === "23514") throw err.invalidBody("note is required for explained");
    throw e;
  }
}

const alreadyReviewed = () => new ApiError(409, "already_reviewed", "You have already reviewed this flag");
