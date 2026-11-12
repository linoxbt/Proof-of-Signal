"use client";

import { useTranslations } from "next-intl";
import { HashText } from "@/components/hash";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTimeWat } from "@/lib/format";
import { useApiData } from "@/lib/hooks";

function metricValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function MethodData() {
  const t = useTranslations("method");
  const m = useApiData("method", (s) => api.method(s));
  if (m.error) return <ErrorBox error={m.error} onRetry={m.reload} />;
  if (!m.data) return <LoadingLine />;
  const d = m.data;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("modelCardTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {d.model_versions.length === 0 ? <p className="text-muted-foreground">{t("none")}</p> : null}
          {d.model_versions.map((v) => (
            <div key={v.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{v.id}</span>
                {v.is_current ? <Badge variant="solid">{t("current")}</Badge> : null}
                <span className="text-sm text-muted-foreground">
                  {t("trainedAt")}: {formatDateTimeWat(v.trained_at)}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(v.metrics ?? {}).map(([k, val]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono">{metricValue(val)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("snapshotsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {d.snapshots.length === 0 ? <p className="text-muted-foreground">{t("none")}</p> : null}
          {d.snapshots.map((s) => (
            <dl key={s.id} className="grid gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{t("election")}</dt>
              <dd className="font-mono">{s.election_id}</dd>
              <dt className="text-muted-foreground">{t("modelVersion")}</dt>
              <dd className="font-mono">{s.model_version}</dd>
              <dt className="text-muted-foreground">{t("frozenAt")}</dt>
              <dd>{formatDateTimeWat(s.frozen_at)}</dd>
              <dt className="text-muted-foreground">{t("rows")}</dt>
              <dd>{s.row_count}</dd>
              <dt className="text-muted-foreground">{t("sha256")}</dt>
              <dd>
                <HashText value={s.sha256} label={`${t("sha256")} ${s.election_id}`} />
              </dd>
              <dt className="text-muted-foreground">{t("tsa")}</dt>
              <dd>{s.tsa_at ? formatDateTimeWat(s.tsa_at) : t("notStamped")}</dd>
            </dl>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("auditTitle")}</CardTitle>
          <CardDescription>{t("auditIntro")}</CardDescription>
        </CardHeader>
        <CardContent>
          {d.audit_roots.length === 0 ? <p className="text-muted-foreground">{t("none")}</p> : null}
          <ul className="divide-y divide-border">
            {d.audit_roots.map((r) => (
              <li key={r.day} className="grid gap-x-4 py-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)_12rem] sm:items-center">
                <span className="font-medium">{r.day}</span>
                <HashText value={r.root_hash} label={`${t("rootHash")} ${r.day}`} />
                <span className="text-muted-foreground">
                  {t("tsa")}: {r.tsa_at ? formatDateTimeWat(r.tsa_at) : t("notStamped")}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
