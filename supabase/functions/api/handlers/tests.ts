// POST /v1/tests: the signed test payload, checked in the contract's order.

import { err, json, readJson } from "../lib/http.ts";
import { b64url, hex, sha256, verifyEs256 } from "../lib/crypto.ts";
import { canonicalBytes } from "../lib/jcs.ts";
import { type Ctx, limitIp, progressFor, type Req } from "../lib/context.ts";
import { dbRadio, parseMccMnc, type Payload, validatePayload } from "../lib/schema.ts";
import { type CheckResult, runChecks, trust as trustOf } from "../lib/checks.ts";
import { pgCode, type Sql, type Tx } from "../lib/db.ts";
import type postgres from "postgres";

class Duplicate extends Error {}

async function storedResult(sql: Sql | Tx, testId: string, status = 200): Promise<Response> {
  const [t] = await sql`
    select id, pu_code, status, reject_reason, trust::float8 as trust from public.tests where id = ${testId}`;
  const progress = await progressFor(sql as Sql, t.pu_code);
  return json(
    { test_id: t.id, status: t.status, reject_reason: t.reject_reason, trust: t.trust, progress },
    status,
  );
}

async function findDuplicate(sql: Sql | Tx, shaHex: string, p: Payload): Promise<string | null> {
  const [d] = await sql`select id from public.tests where payload_sha256 = decode(${shaHex}, 'hex')`;
  if (d) return d.id;
  if (p.nonce === null) {
    // An ECDSA signature can be re-encoded (s -> n - s) into another valid
    // signature, which changes payload_sha256. Nonce-bound runs are protected
    // by the single-use nonce; for offline runs, the same device, unit and
    // capture time is the same run.
    const [o] = await sql`
      select id from public.tests
      where device_id = ${p.device_id} and pu_code = ${p.pu_code} and nonce is null
        and captured_at = ${p.ts}::timestamptz`;
    if (o) return o.id;
  }
  return null;
}

export async function postTest(ctx: Ctx, r: Req): Promise<Response> {
  limitIp(ctx, r, "tests", ctx.cfg.ipLimitTests);
  const body = await readJson(r.req);

  // 1. Schema.
  const problem = validatePayload(body);
  if (problem) throw err.schema(problem);
  const p = body as Payload;

  // 2. Device.
  const [dev] = await ctx.sql`
    select id, pubkey, status, reputation::float8 as reputation from public.devices where id = ${p.device_id}`;
  if (!dev) throw err.notFound("Unknown device");
  if (dev.status === "banned") throw err.banned();
  const deviceQuarantined = dev.status === "quarantined";

  // 3. Signature over JCS(payload without sig).
  const { sig, ...unsigned } = p;
  if (!(await verifyEs256(dev.pubkey, sig, canonicalBytes(unsigned)))) throw err.badSignature();

  // 4. Duplicate.
  const shaHex = hex(await sha256(canonicalBytes(p)));
  const dup = await findDuplicate(ctx.sql, shaHex, p);
  if (dup) return await storedResult(ctx.sql, dup);

  try {
    return await ctx.sql.begin((tx) =>
      ingest(ctx, tx, p, dev as unknown as { id: string; reputation: number }, deviceQuarantined, shaHex)
    ) as Response;
  } catch (e) {
    if (e instanceof Duplicate || (pgCode(e) === "23505" && String((e as Error).message).includes("payload_sha256"))) {
      const again = await findDuplicate(ctx.sql, shaHex, p);
      if (again) return await storedResult(ctx.sql, again);
    }
    throw e;
  }
}

async function ingest(
  ctx: Ctx,
  tx: Tx,
  p: Payload,
  dev: { id: string; reputation: number },
  deviceQuarantined: boolean,
  shaHex: string,
): Promise<Response> {
  // 5. Nonce.
  if (p.nonce !== null) {
    const [c] = await tx`select public.consume_nonce(${p.nonce}, ${p.device_id}::uuid, interval '7 days') as ok`;
    if (!c.ok) {
      const [n] = await tx`
        select device_id, used_at is not null as used, issued_at <= now() - interval '7 days' as old
        from public.nonces where nonce = ${p.nonce}`;
      if (!n || n.device_id !== p.device_id) throw err.unknownNonce();
      if (n.used) {
        // A concurrent identical submission may have won the race.
        if (await findDuplicate(tx, shaHex, p)) throw new Duplicate();
        throw err.nonceUsed();
      }
      if (n.old) throw err.nonceExpired();
      throw err.unknownNonce();
    }
  }

  // 6. Integrity token, bound to the nonce (or, offline, to device and ts).
  let integrityOk = true;
  if (!deviceQuarantined) {
    const requestHash = b64url(await sha256(p.nonce !== null ? p.nonce : `${p.device_id}|${p.ts}`));
    const v = await ctx.integrity.verify(p.integrity, requestHash);
    integrityOk = v.ok;
    if (!v.ok) {
      console.warn(`device ${p.device_id} failed integrity on test: ${v.reason}`);
      await tx`
        update public.devices set status = 'quarantined', status_reason = 'integrity',
               integrity_level = ${v.level}, integrity_checked_at = now()
        where id = ${p.device_id} and status = 'active'`;
    }
  }

  // 7. Checks.
  const fixSql = () =>
    tx`extensions.st_setsrid(extensions.st_makepoint(${p.fix.lng}::float8, ${p.fix.lat}::float8), 4326)::extensions.geography`;
  const [pu] = await tx`
    select geom is not null as has_point,
           extensions.st_distance(geom, ${fixSql()})::float8 as dist_m
    from public.polling_units where pu_code = ${p.pu_code}`;
  if (!pu) throw err.notFound(`Unknown polling unit ${p.pu_code}`);
  const puDistM: number | null = pu.has_point ? pu.dist_m : null;

  let result: CheckResult;
  if (deviceQuarantined) {
    result = { status: "quarantined", reason: "device_quarantined", quarantineDevice: false };
  } else if (!integrityOk) {
    result = { status: "quarantined", reason: "integrity", quarantineDevice: false };
  } else {
    const [prev] = await tx`
      select extensions.st_distance(fix, ${fixSql()})::float8 as dist_m,
             abs(extract(epoch from captured_at - ${p.ts}::timestamptz))::float8 as dt_s,
             acc_m::float8 as acc_m
      from public.tests
      where device_id = ${p.device_id} and fix is not null and not mock and status <> 'rejected'
        and captured_at between ${p.ts}::timestamptz - interval '24 hours'
                            and ${p.ts}::timestamptz + interval '24 hours'
      order by abs(extract(epoch from captured_at - ${p.ts}::timestamptz))
      limit 1`;

    const slots = p.sims.map((s) => s.slot);
    const receipts = p.nonce === null ? [] : await tx`
      select pr.sim_slot::int as slot, pr.bytes, pr.asn,
             exists (select 1 from public.mobile_asns m where m.asn = pr.asn) as mobile
      from public.probe_receipts pr
      where pr.nonce = ${p.nonce} and pr.sim_slot = any(string_to_array(${slots.join(",")}::text, ',')::smallint[])`;

    const regCells: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const s of p.sims) {
      const sim = parseMccMnc(s.mcc_mnc);
      for (const c of s.cells) {
        if (!c.reg || c.area == null || c.cid == null) continue;
        const k = {
          radio: dbRadio(c.radio),
          mcc: c.mcc ?? sim.mcc,
          mnc: c.mnc ?? sim.mnc,
          area: c.area,
          cid: c.cid,
          ta: c.ta ?? null,
        };
        const key = JSON.stringify(k);
        if (!seen.has(key)) {
          seen.add(key);
          regCells.push(k);
        }
      }
    }
    const cells = regCells.length === 0 ? [] : await tx`
      select k.radio, k.ta, c.range_m,
             extensions.st_distance(c.geom, ${fixSql()})::float8 as dist_m
      from jsonb_to_recordset(${tx.json(regCells as postgres.JSONValue)})
             as k(radio text, mcc int, mnc int, area int, cid bigint, ta int)
      join public.cells c
        on c.radio = k.radio::public.radio_type and c.mcc = k.mcc and c.mnc = k.mnc
       and c.area = k.area and c.cid = k.cid
      where c.geom is not null`;

    const [now] = await tx`select (extract(epoch from now()) * 1000)::float8 as ms`;
    result = runChecks({
      mock: p.fix.mock,
      accM: p.fix.acc_m,
      puDistM,
      placeRadiusM: ctx.cfg.placeRadiusM,
      prev: prev ? { distM: prev.dist_m, dtS: prev.dt_s, accM: prev.acc_m } : null,
      okSlots: p.sims.filter((s) => s.upload.ok).map((s) => s.slot),
      receipts: receipts.map((x) => ({ slot: x.slot, bytes: x.bytes, asn: x.asn, mobileAsn: x.mobile })),
      cells: cells.map((x) => ({ radio: x.radio, distM: x.dist_m, rangeM: x.range_m, ta: x.ta })),
      tsMs: Date.parse(p.ts),
      nowMs: now.ms,
    });
    if (result.quarantineDevice) {
      await tx`
        update public.devices set status = 'quarantined', status_reason = ${result.reason}
        where id = ${p.device_id} and status = 'active'`;
    }
  }
  const trust = trustOf(result.status, dev.reputation, puDistM);

  // 8. Store. captured_at is capped at received_at + 10 min (a table check);
  // such a test is always rejected bad_timestamp or quarantined earlier, and
  // payload_raw keeps the original ts.
  const [t] = await tx`
    insert into public.tests (device_id, pu_code, nonce, captured_at, fix, acc_m, mock, app_version,
                              payload_sha256, signature, payload_raw, trust, status, reject_reason)
    values (${p.device_id}, ${p.pu_code}, ${p.nonce},
            least(${p.ts}::timestamptz, now() + interval '10 minutes'),
            ${fixSql()}, ${p.fix.acc_m}, ${p.fix.mock}, ${p.app},
            decode(${shaHex}, 'hex'), ${p.sig}, ${tx.json(p as unknown as postgres.JSONValue)},
            ${trust}, ${result.status}::public.test_status, ${result.reason})
    returning id, status, reject_reason`;
  if (t.status !== "accepted" && trust > 0) {
    // The daily cap trigger quarantined it: quarantined tests carry no trust.
    await tx`update public.tests set trust = 0 where id = ${t.id}`;
  }

  const sims = p.sims.map((s) => {
    const { mcc, mnc } = parseMccMnc(s.mcc_mnc);
    return {
      sim_slot: s.slot,
      mcc,
      mnc,
      net_type: s.net_type,
      latency_ms: s.latency_ms,
      ...s.upload,
    };
  });
  await tx`
    insert into public.test_sims (test_id, sim_slot, mcc, mnc, net_type, latency_ms, upload_ok, upload_bytes,
                                  dns_ms, connect_ms, tls_ms, ttfb_ms, total_ms, http_status, err)
    select ${t.id}, k.sim_slot, k.mcc, k.mnc, k.net_type,
           array(select e::int from jsonb_array_elements_text(k.latency_ms) with ordinality as a(e, i) order by i),
           k.ok, k.bytes, k.dns_ms, k.connect_ms, k.tls_ms, k.ttfb_ms, k.total_ms, k.http_status, k.err
    from jsonb_to_recordset(${tx.json(sims as postgres.JSONValue)}) as k(
      sim_slot smallint, mcc smallint, mnc smallint, net_type text, latency_ms jsonb, ok boolean, bytes int,
      dns_ms int, connect_ms int, tls_ms int, ttfb_ms int, total_ms int, http_status smallint, err text)`;

  const cellRows = p.sims.flatMap((s) => s.cells.map((c) => ({ ...c, sim_slot: s.slot, radio: dbRadio(c.radio) })));
  if (cellRows.length > 0) {
    await tx`
      insert into public.test_cells (test_id, sim_slot, sample_idx, reg, radio, mcc, mnc, area, cid, pci, earfcn,
                                     rsrp, rsrq, rssnr, rssi, ta, level)
      select ${t.id}, k.sim_slot, k.sample, k.reg, k.radio::public.radio_type, k.mcc, k.mnc, k.area, k.cid, k.pci,
             k.earfcn, k.rsrp, k.rsrq, k.rssnr, k.rssi, k.ta, k.level
      from jsonb_to_recordset(${tx.json(cellRows as postgres.JSONValue)}) as k(
        sim_slot smallint, sample smallint, reg boolean, radio text, mcc smallint, mnc smallint, area int,
        cid bigint, pci smallint, earfcn int, rsrp smallint, rsrq smallint, rssnr smallint, rssi smallint,
        ta smallint, level smallint)`;
  }

  // Crowd location: only fixes from accepted tests vote.
  if (!pu.has_point && t.status === "accepted") {
    await tx`
      insert into public.pu_location_votes (pu_code, device_id, test_id, geom, acc_m)
      values (${p.pu_code}, ${p.device_id}, ${t.id}, ${fixSql()}, ${p.fix.acc_m})`;
    await tx`select public.recompute_pu_location(${p.pu_code})`;
  }

  await tx`update public.devices set last_seen_at = now(), app_version = ${p.app} where id = ${p.device_id}`;
  return await storedResult(tx, t.id, 201);
}
