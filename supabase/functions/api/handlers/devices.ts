// POST /v1/devices, DELETE /v1/devices/{id}/data, GET /v1/nonce

import { err, isObject, json, readJson } from "../lib/http.ts";
import { b64decode, b64encode, b64url, importSpkiP256, randomToken, sha256, verifyEs256 } from "../lib/crypto.ts";
import { canonicalBytes } from "../lib/jcs.ts";
import { type Ctx, limitIp, type Req, UUID_RE } from "../lib/context.ts";
import { IntegrityUnavailable } from "../lib/integrity.ts";

export async function registerDevice(ctx: Ctx, r: Req): Promise<Response> {
  limitIp(ctx, r, "devices", ctx.cfg.ipLimitDevices);
  const body = await readJson(r.req);
  if (!isObject(body) || typeof body.pubkey !== "string") throw err.invalidBody("pubkey is required");
  if (body.integrity_token !== undefined && typeof body.integrity_token !== "string") {
    throw err.invalidBody("integrity_token must be a string");
  }
  if (body.app_version !== undefined && (typeof body.app_version !== "string" || body.app_version.length > 32)) {
    throw err.invalidBody("app_version must be a string of at most 32 characters");
  }
  let der: Uint8Array;
  try {
    der = b64decode(body.pubkey);
    await importSpkiP256(der);
  } catch {
    throw err.invalidBody("pubkey must be base64 of a P-256 SubjectPublicKeyInfo");
  }
  const pubkey = b64encode(der); // normalised
  const appVersion = (body.app_version as string | undefined) ?? null;

  const [existing] = await ctx.sql`
    select id, status, integrity_level from public.devices where pubkey = ${pubkey}`;
  if (existing) {
    return json({ device_id: existing.id, status: existing.status, integrity_level: existing.integrity_level }, 200);
  }

  const requestHash = b64url(await sha256(der));
  let verdict;
  try {
    verdict = await ctx.integrity.verify((body.integrity_token as string | undefined) ?? "", requestHash);
  } catch (e) {
    if (e instanceof IntegrityUnavailable) console.error("integrity unavailable:", e.message);
    throw e;
  }
  const status = verdict.ok ? "active" : "quarantined";
  const [row] = await ctx.sql`
    insert into public.devices (pubkey, integrity_level, integrity_checked_at, status, status_reason, app_version, last_seen_at)
    values (${pubkey}, ${verdict.level}, now(), ${status}, ${verdict.ok ? null : "integrity"}, ${appVersion}, now())
    on conflict (pubkey) do nothing
    returning id, status, integrity_level`;
  if (!row) {
    // Lost a race with the same key: return the winner.
    const [d] = await ctx.sql`select id, status, integrity_level from public.devices where pubkey = ${pubkey}`;
    return json({ device_id: d.id, status: d.status, integrity_level: d.integrity_level }, 200);
  }
  if (!verdict.ok) console.warn(`device ${row.id} quarantined at registration: ${verdict.reason}`);
  return json({ device_id: row.id, status: row.status, integrity_level: row.integrity_level }, 201);
}

export async function eraseDevice(ctx: Ctx, r: Req): Promise<Response> {
  const id = r.params.id;
  if (!UUID_RE.test(id)) throw err.notFound("Unknown device");
  const body = await readJson(r.req);
  if (!isObject(body) || typeof body.ts !== "string" || typeof body.sig !== "string") {
    throw err.invalidBody("ts and sig are required");
  }
  const ts = Date.parse(body.ts);
  if (!Number.isFinite(ts) || !/^\d{4}-\d{2}-\d{2}T/.test(body.ts)) throw err.invalidBody("ts must be RFC 3339");
  const [dev] = await ctx.sql`select id, pubkey from public.devices where id = ${id}`;
  if (!dev) throw err.notFound("Unknown device");
  const signed = canonicalBytes({ device_id: dev.id, op: "erase", ts: body.ts });
  if (!(await verifyEs256(dev.pubkey, body.sig, signed))) throw err.badSignature();
  if (Math.abs(Date.now() - ts) > 5 * 60_000) throw err.badSignature("ts is not within 5 minutes of server time");
  const [res] = await ctx.sql`select public.erase_device_data(${id}::uuid) as n`;
  if (res.n === null) throw err.notFound("Unknown device");
  return json({ tests_deleted: res.n }, 200);
}

export async function issueNonce(ctx: Ctx, r: Req): Promise<Response> {
  limitIp(ctx, r, "nonce", ctx.cfg.ipLimitNonce);
  const deviceId = r.url.searchParams.get("device_id") ?? "";
  if (!UUID_RE.test(deviceId)) throw err.invalidQuery("device_id must be a uuid");
  return await ctx.sql.begin(async (tx) => {
    // Serialise nonce issuance per device so the hourly count is exact.
    const [dev] = await tx`select id, status from public.devices where id = ${deviceId} for update`;
    if (!dev) throw err.notFound("Unknown device");
    if (dev.status === "banned") throw err.banned();
    if (dev.status === "quarantined") throw err.quarantined();
    const [c] = await tx`
      select count(*)::int as n,
             extract(epoch from (min(issued_at) + interval '1 hour' - now()))::float8 as wait_s
      from public.nonces
      where device_id = ${deviceId} and issued_at > now() - interval '1 hour'`;
    if (c.n >= ctx.cfg.deviceNonceLimit) throw err.rateLimited(c.wait_s ?? 60);
    const nonce = "n_" + randomToken(16); // 16 bytes -> 22 base64url chars
    const [n] = await tx`
      insert into public.nonces (nonce, device_id) values (${nonce}, ${deviceId})
      returning nonce, expires_at`;
    await tx`update public.devices set last_seen_at = now() where id = ${deviceId}`;
    return json({ nonce: n.nonce, expires_at: new Date(n.expires_at).toISOString() }, 200);
  });
}
