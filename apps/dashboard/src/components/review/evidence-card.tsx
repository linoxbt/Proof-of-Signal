"use client";

import { Info, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Estimate } from "@/components/estimate";
import { HashText } from "@/components/hash";
import type { Evidence } from "@/lib/api/types";
import { formatDistance, formatEstimate, formatMinutes, formatPercent, formatTimeWat } from "@/lib/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-3">
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function CauseBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="py-1">
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">{formatPercent(value)}</span>
      </div>
      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full bg-secondary-foreground/70" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Every field of the contract's Evidence object, in plain language. */
export function EvidenceCard({ e }: { e: Evidence }) {
  const t = useTranslations("review");
  const tc = useTranslations("common");
  const tp = useTranslations("pu");
  return (
    <div className="flex flex-col gap-3" data-testid="evidence-card">
      <div>
        <h2 className="text-xl font-semibold">{e.name}</h2>
        <p className="text-sm text-muted-foreground">
          {e.pu_code} · {e.ward} · {e.lga}
        </p>
      </div>

      <Section title={t("coverage")}>
        <dl className="divide-y divide-border">
          <Row label={t("bestScore")}>
            <Estimate p={e.p_best} lo={e.p_best_lo} hi={e.p_best_hi} tests={e.n_tests} bar />
          </Row>
          <Row label={tc("measured")}>{e.measured ? t("measuredYes") : t("measuredNo")}</Row>
          <Row label={tp("history")}>
            {tc("tests", { count: e.n_tests })} · {tc("devices", { count: e.n_devices })} · {tc("evenings", { count: e.n_evenings })}
          </Row>
          <Row label={t("carriers")}>
            <ul className="flex flex-col gap-1">
              {e.carriers.map((c) => (
                <li key={c.mnc} className="flex flex-wrap justify-between gap-x-3">
                  <span>{c.carrier ?? `MNC ${c.mnc}`}</span>
                  <span className="tabular-nums">{formatEstimate(c.p, c.p_lo, c.p_hi)}</span>
                </li>
              ))}
            </ul>
          </Row>
        </dl>
      </Section>

      <Section title={t("neighbours")}>
        <p className="mb-1 text-sm">{t("neighboursCount", { count: e.neighbours_uploaded })}</p>
        <ul className="flex flex-col divide-y divide-border">
          {e.neighbours.map((n) => (
            <li key={n.pu_code} className="flex flex-wrap justify-between gap-x-3 py-1.5 text-sm">
              <span>
                <span className="font-medium">{n.name}</span> <span className="text-muted-foreground">{n.pu_code}</span>
              </span>
              <span className="text-muted-foreground">
                {formatDistance(n.dist_m)} · {n.shared === "ward" ? t("sharedWard") : t("sharedCell")} ·{" "}
                {t("uploadedAt", { time: formatTimeWat(n.uploaded_at) })}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("timing")}>
        <dl className="divide-y divide-border">
          <Row label={t("minutesSinceClose")}>{formatMinutes(e.minutes_since_close)}</Row>
          <Row label={t("minutesPending")}>{formatMinutes(e.minutes_pending)}</Row>
          <Row label={t("strongPending")}>{formatPercent(e.s_t)}</Row>
        </dl>
      </Section>

      <Section title={t("causes")}>
        <CauseBar label={t("pNetwork")} value={e.p_network} />
        <CauseBar label={t("pDelay")} value={e.p_delay} />
        <CauseBar label={t("pOther")} value={e.p_other} />
        <p className="mt-1 text-sm text-muted-foreground">
          {t("causesNote")} {tc("bestCarrier")}: {formatEstimate(e.p_best, e.p_best_lo, e.p_best_hi)} · {tc("tests", { count: e.n_tests })}
        </p>
      </Section>

      <Section title={t("snapshot")}>
        <dl className="divide-y divide-border">
          <Row label={t("snapshotId")}>
            <code className="font-mono text-sm break-all">{e.snapshot_id}</code>
          </Row>
          <Row label={t("snapshotHash")}>
            <HashText value={e.snapshot_sha256} label={t("snapshotHash")} />
          </Row>
        </dl>
      </Section>

      <div className="flex gap-2 rounded-md border border-border bg-muted p-3 text-sm" data-testid="caveat">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div>
          <div className="font-semibold">{t("caveatTitle")}</div>
          <p>{e.caveat}</p>
        </div>
      </div>
    </div>
  );
}

export function TwoPersonState({ status }: { status: string }) {
  const t = useTranslations("review");
  const text =
    status === "awaiting_second" ? t("twoPersonAwaiting") : status === "unreviewed" ? t("twoPersonUnreviewed") : t("twoPersonDone");
  return (
    <div
      className="flex items-start gap-2 rounded-md border-2 p-3 text-sm"
      style={{ borderColor: status === "awaiting_second" ? "#6d4fb3" : "var(--border)" }}
      data-testid="two-person"
      data-status={status}
    >
      <Users className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div>
        <div className="font-semibold">
          {t("twoPerson")}: {t(`statuses.${status}`)}
        </div>
        <p>{text}</p>
      </div>
    </div>
  );
}
