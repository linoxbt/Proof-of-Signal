"use client";

import { FileDown, FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { BandSwatch } from "@/components/coverage/coverage-view";
import { Estimate } from "@/components/estimate";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/field";
import { api } from "@/lib/api";
import type { RegisterRow } from "@/lib/api/types";
import { DEFAULT_STATE_CODE, IS_DEMO } from "@/lib/config";
import { coverageBand } from "@/lib/coverage";
import { downloadBlob } from "@/lib/csv";
import { formatDateTimeWat } from "@/lib/format";
import { useApiData } from "@/lib/hooks";
import { stateOptions } from "@/lib/states";
import { cn } from "@/lib/utils";

/** Contract suggested_action values → message keys. */
const ACTIONS: Record<string, "satellite" | "alternate" | "fallback" | "monitor"> = {
  "satellite or alternate upload point": "satellite",
  "alternate upload point or signal booster": "alternate",
  "confirm fallback plan": "fallback",
  monitor: "monitor",
};

const LIMIT = 500;

export function filterRows(rows: RegisterRow[], f: { action: string; maxP: string; text: string }): RegisterRow[] {
  const needle = f.text.trim().toLowerCase();
  const max = f.maxP ? Number(f.maxP) : null;
  return rows.filter(
    (r) =>
      (!f.action || r.suggested_action === f.action) &&
      (max === null || r.p_best <= max) &&
      (!needle || r.pu_code.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || r.ward.toLowerCase().includes(needle)),
  );
}

export function RegisterView() {
  const t = useTranslations();
  const [state, setState] = useState(DEFAULT_STATE_CODE);
  const [lga, setLga] = useState("");
  const [action, setAction] = useState("");
  const [maxP, setMaxP] = useState("");
  const [text, setText] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  const query = { state, lga: lga ? Number(lga) : undefined, limit: LIMIT };
  const reg = useApiData(`reg:${state}:${lga}`, (s) => api.register(query, s));
  const progress = useApiData(`prog:${state}`, (s) => api.mapProgress(state, s));
  const rows = useMemo(() => filterRows(reg.data?.rows ?? [], { action, maxP, text }), [reg.data, action, maxP, text]);

  const stateName = stateOptions().find((s) => s.code === state)?.name ?? String(state);
  const lgaName = progress.data?.lgas.find((l) => String(l.lga_code) === lga)?.lga;
  const filtersText = [
    `${t("common.state")}: ${stateName}`,
    `${t("common.lga")}: ${lgaName ?? t("common.allLgas")}`,
    action && ACTIONS[action] ? `${t("register.action")}: ${t(`register.actions.${ACTIONS[action]}`)}` : null,
    maxP ? `${t("register.maxChance")} ${Math.round(Number(maxP) * 100)}%` : null,
    text.trim() ? `"${text.trim()}"` : null,
  ]
    .filter(Boolean)
    .join("; ");

  async function exportPdf() {
    setPdfBusy(true);
    setErr(null);
    try {
      const { renderRegisterPdf } = await import("@/lib/pdf/register-pdf");
      const blob = await renderRegisterPdf(rows, {
        title: "Transmission Risk Register",
        modelVersion: reg.data?.model_version ?? null,
        filters: filtersText,
        generatedAt: formatDateTimeWat(new Date().toISOString()),
        demo: IS_DEMO,
      });
      downloadBlob(blob, `transmission-risk-register-${state}${IS_DEMO ? "-synthetic-demo" : ""}.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadDemoCsv() {
    setErr(null);
    try {
      const csv = await api.registerCsv(query);
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `transmission-risk-register-${state}-synthetic-demo.csv`);
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t("register.title")}</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">{t("register.intro")}</p>
          {reg.data?.model_version ? (
            <p className="mt-1 text-sm text-muted-foreground">{t("register.modelVersion", { version: reg.data.model_version })}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {IS_DEMO ? (
            <Button variant="outline" onClick={() => void downloadDemoCsv()} data-testid="csv-download">
              <FileDown aria-hidden="true" />
              {t("register.downloadCsv")}
            </Button>
          ) : (
            <a href={api.registerCsvUrl(query)} className={buttonVariants({ variant: "outline" })} data-testid="csv-download" download>
              <FileDown aria-hidden="true" />
              {t("register.downloadCsv")}
            </a>
          )}
          <Button onClick={() => void exportPdf()} disabled={pdfBusy || !rows.length} data-testid="pdf-export">
            <FileText aria-hidden="true" />
            {pdfBusy ? t("register.preparingPdf") : t("register.downloadPdf")}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("register.csvNote")} {t("register.pdfNote")}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("register.filters")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-state">{t("common.state")}</Label>
            <Select
              id="r-state"
              value={state}
              onChange={(e) => {
                setState(Number(e.target.value));
                setLga("");
              }}
            >
              {stateOptions().map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-lga">{t("common.lga")}</Label>
            <Select id="r-lga" value={lga} onChange={(e) => setLga(e.target.value)}>
              <option value="">{t("common.allLgas")}</option>
              {(progress.data?.lgas ?? []).map((l) => (
                <option key={l.lga_code} value={l.lga_code}>
                  {l.lga}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-action">{t("register.action")}</Label>
            <Select id="r-action" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">{t("register.allActions")}</option>
              {Object.entries(ACTIONS).map(([a, key]) => (
                <option key={a} value={a}>
                  {t(`register.actions.${key}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-max">{t("register.maxChance")}</Label>
            <Select id="r-max" value={maxP} onChange={(e) => setMaxP(e.target.value)}>
              <option value="">{t("register.any")}</option>
              <option value="0.2">20%</option>
              <option value="0.5">50%</option>
              <option value="0.8">80%</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-text">{t("common.name")}</Label>
            <Input id="r-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("register.searchPlaceholder")} />
          </div>
        </CardContent>
      </Card>

      {err ? <ErrorBox error={err} /> : null}
      {reg.error ? <ErrorBox error={reg.error} onRetry={reg.reload} /> : null}
      {reg.loading && !reg.data ? <LoadingLine /> : null}

      {reg.data ? (
        <Card>
          <CardHeader>
            <CardDescription>{t("common.showing", { shown: rows.length, total: reg.data.rows.length })}</CardDescription>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? <p className="text-muted-foreground">{t("register.none")}</p> : null}
            {/* Wide screens: table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">{t("register.rank")}</th>
                    <th className="py-2 pr-2 font-medium">{t("common.name")}</th>
                    <th className="py-2 pr-2 font-medium">
                      {t("common.ward")} / {t("common.lga")}
                    </th>
                    <th className="py-2 pr-2 font-medium">{t("register.chance")}</th>
                    <th className="py-2 pr-2 font-medium">{t("register.carriersSeen")}</th>
                    <th className="py-2 font-medium">{t("register.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.pu_code} className="border-b border-border align-top last:border-0">
                      <td className="py-2 pr-2 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-2">
                        <a href={`/pu/${encodeURIComponent(r.pu_code)}`} className="font-medium hover:underline">
                          {r.name}
                        </a>
                        <div className="font-mono text-xs text-muted-foreground">{r.pu_code}</div>
                      </td>
                      <td className="py-2 pr-2">
                        {r.ward}
                        <div className="text-muted-foreground">{r.lga}</div>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-start gap-2">
                          <BandSwatch band={coverageBand(r.p_best)} className="mt-0.5" />
                          <Estimate p={r.p_best} lo={r.p_lo} hi={r.p_hi} tests={r.n_tests} />
                        </div>
                      </td>
                      <td className="py-2 pr-2">{r.carriers_seen.split(";").filter(Boolean).join(", ") || "—"}</td>
                      <td className="py-2">
                        <ActionLabel action={r.suggested_action} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Phones: cards. */}
            <ol className="flex flex-col gap-2 md:hidden">
              {rows.map((r, i) => (
                <li key={r.pu_code} className="rounded-md border border-border p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-sm tabular-nums text-muted-foreground">{i + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <a href={`/pu/${encodeURIComponent(r.pu_code)}`} className="font-medium hover:underline">
                        {r.name}
                      </a>
                      <div className="text-sm text-muted-foreground">
                        {r.pu_code} · {r.ward} · {r.lga}
                      </div>
                      <div className="mt-1 flex items-start gap-2">
                        <BandSwatch band={coverageBand(r.p_best)} className="mt-0.5" />
                        <Estimate p={r.p_best} lo={r.p_lo} hi={r.p_hi} tests={r.n_tests} />
                      </div>
                      <div className="mt-1 text-sm">
                        {t("register.carriersSeen")}: {r.carriers_seen.split(";").filter(Boolean).join(", ") || "—"}
                      </div>
                      <div className="mt-1">
                        <ActionLabel action={r.suggested_action} />
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ActionLabel({ action }: { action: string }) {
  const t = useTranslations("register.actions");
  const key = ACTIONS[action];
  return (
    <span className={cn("inline-block rounded-md bg-secondary px-2 py-0.5 text-sm font-medium text-secondary-foreground")}>
      {key ? t(key) : action}
    </span>
  );
}
