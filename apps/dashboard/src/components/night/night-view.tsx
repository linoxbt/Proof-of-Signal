"use client";

import { IconLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import { CirclePause } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { BucketBadge, BucketIcon, BucketLegend } from "@/components/bucket";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { boundsOf } from "@/components/map/deck-map";
import { MapFrame } from "@/components/map/map-frame";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/field";
import { api } from "@/lib/api";
import type { NightSummary, NightUnitProps, PointFeature } from "@/lib/api/types";
import { BUCKETS, BUCKET_LIST, bucketSvgDataUrl, displayStatus, type DisplayStatus } from "@/lib/buckets";
import { MODE } from "@/lib/config";
import { formatMinutes, formatTimeWat, share } from "@/lib/format";
import { useApiData, useDemoVersion } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { DemoTimeline } from "./demo-timeline";
import { useDemoStepParam } from "./use-demo-step-param";

type Unit = PointFeature<NightUnitProps>;
const LIVE_REFRESH_MS = 30_000;

export function NightView() {
  const t = useTranslations();
  useDemoStepParam();
  const params = useSearchParams();
  const demoVersion = useDemoVersion();
  const refresh = MODE === "live" ? LIVE_REFRESH_MS : undefined;

  const elections = useApiData("elections", (s) => api.elections(s));
  const [chosen, setChosen] = useState<string | null>(params.get("election"));
  const electionId = chosen ?? elections.data?.elections[0]?.id ?? null;
  const election = elections.data?.elections.find((e) => e.id === electionId) ?? null;

  const summary = useApiData(electionId ? `sum:${electionId}:${demoVersion}` : null, (s) => api.nightSummary(electionId!, s), refresh);
  const units = useApiData(electionId ? `units:${electionId}:${demoVersion}` : null, (s) => api.nightUnits(electionId!, undefined, s), refresh);

  const [filter, setFilter] = useState<DisplayStatus | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const features = useMemo(() => units.data?.features ?? [], [units.data]);
  const counts = useMemo(() => {
    const c: Partial<Record<DisplayStatus, number>> = {};
    for (const f of features) {
      const s = displayStatus(f.properties);
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [features]);
  const bounds = useMemo(() => boundsOf(features.map((f) => f.geometry.coordinates)), [features]);

  const layers = useMemo(() => {
    // Draw uploaded first so units still missing sit on top.
    const data = [...features].sort((a, b) => BUCKETS[displayStatus(b.properties)].order - BUCKETS[displayStatus(a.properties)].order);
    return [
      new IconLayer<Unit>({
        id: "night-units",
        data,
        getPosition: (d) => d.geometry.coordinates,
        getIcon: (d) => {
          const s = displayStatus(d.properties);
          return { id: s, url: bucketSvgDataUrl(s, 64), width: 64, height: 64, anchorY: 32 };
        },
        getSize: (d) => (d.properties.pu_code === selected ? 34 : filter !== "all" && displayStatus(d.properties) !== filter ? 12 : 24),
        sizeUnits: "pixels",
        pickable: true,
        onClick: (info) => {
          if (info.object) setSelected(info.object.properties.pu_code);
        },
        updateTriggers: { getSize: [selected, filter] },
      }),
    ];
  }, [features, selected, filter]);

  const tooltip = (info: PickingInfo) => {
    const o = info.object as Unit | undefined;
    if (!o) return null;
    const s = displayStatus(o.properties);
    return `${o.properties.name}\n${t(`buckets.${s}`)}${o.properties.review_outcome ? `\n${t(`buckets.outcome.${o.properties.review_outcome}`)}` : ""}`;
  };

  const matching = features
    .filter((f) => filter === "all" || displayStatus(f.properties) === filter)
    .sort((a, b) => BUCKETS[displayStatus(a.properties)].order - BUCKETS[displayStatus(b.properties)].order || a.properties.pu_code.localeCompare(b.properties.pu_code));
  const listed = showAll ? matching : matching.slice(0, 15);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t("night.title")}</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">{t("night.intro")}</p>
        </div>
        {elections.data && elections.data.elections.length > 1 ? (
          <div className="flex flex-col gap-1 sm:w-72">
            <Label htmlFor="election">{t("night.election")}</Label>
            <Select id="election" value={electionId ?? ""} onChange={(e) => setChosen(e.target.value)}>
              {elections.data.elections.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.is_replay ? ` (${t("night.replay")})` : ""}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      <DemoTimeline />

      {elections.error ? <ErrorBox error={elections.error} onRetry={elections.reload} /> : null}
      {summary.error ? <ErrorBox error={summary.error} onRetry={summary.reload} /> : null}

      {summary.data?.system_stall.active ? <StallBanner summary={summary.data} /> : null}

      {summary.data ? (
        <SummaryCard summary={summary.data} electionName={election?.name ?? summary.data.election_id} isReplay={election?.is_replay ?? false} />
      ) : summary.loading || elections.loading ? (
        <LoadingLine />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-3">
          <MapFrame className="h-[50vh] min-h-72 lg:h-[30rem]" layers={layers} bounds={bounds} ariaLabel={t("night.unitsTitle")} getTooltip={tooltip} />
          <p className="text-sm text-muted-foreground">{t("night.caveat")}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("buckets.legend")}</CardTitle>
          </CardHeader>
          <CardContent>
            <BucketLegend counts={counts} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>{t("night.unitsTitle")}</CardTitle>
            <CardDescription>{t("common.showing", { shown: listed.length, total: matching.length })}</CardDescription>
          </div>
          <div className="flex flex-col gap-1 sm:w-72">
            <Label htmlFor="bucket-filter">{t("night.filter")}</Label>
            <Select id="bucket-filter" value={filter} onChange={(e) => setFilter(e.target.value as DisplayStatus | "all")}>
              <option value="all">{t("night.allBuckets")}</option>
              {BUCKET_LIST.map((b) => (
                <option key={b.status} value={b.status}>
                  {t(`buckets.${b.labelKey}`)} ({counts[b.status] ?? 0})
                </option>
              ))}
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {units.error ? <ErrorBox error={units.error} onRetry={units.reload} /> : null}
          {units.loading && !units.data ? <LoadingLine /> : null}
          {units.data && listed.length === 0 ? <p className="text-muted-foreground">{t("night.noUnits")}</p> : null}
          <ul className="divide-y divide-border" data-testid="night-units">
            {listed.map((f) => {
              const p = f.properties;
              const s = displayStatus(p);
              return (
                <li key={p.pu_code} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 py-2", selected === p.pu_code && "bg-accent")}>
                  <Link href={`/pu/${encodeURIComponent(p.pu_code)}`} className="flex min-h-12 min-w-0 flex-1 flex-col justify-center hover:underline">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {p.pu_code} · {p.ward} · {p.lga}
                      {p.first_seen_at ? ` · ${formatTimeWat(p.first_seen_at)}` : ""}
                    </span>
                  </Link>
                  <div className="flex flex-col items-start gap-1 sm:items-end">
                    <BucketBadge status={s} />
                    {p.review_outcome ? <span className="text-sm text-muted-foreground">{t(`buckets.outcome.${p.review_outcome}`)}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {matching.length > listed.length ? (
            <button
              type="button"
              className="mt-2 min-h-12 w-full rounded-md border border-input font-medium hover:bg-muted"
              onClick={() => setShowAll(true)}
            >
              {t("common.showAll", { total: matching.length })}
            </button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function StallBanner({ summary }: { summary: NightSummary }) {
  const t = useTranslations("night");
  return (
    <div role="status" aria-live="polite" data-testid="stall-banner" className="flex items-start gap-3 rounded-lg border-2 p-4 text-white" style={{ background: "#1d5f73", borderColor: "#0f3f4d" }}>
      <CirclePause className="mt-0.5 size-7 shrink-0" aria-hidden="true" />
      <div>
        <p className="text-lg font-bold">{t("stallBanner")}</p>
        <p className="mt-1 text-sm opacity-95">{t("stallDetail", { time: formatTimeWat(summary.system_stall.since) })}</p>
      </div>
    </div>
  );
}

function SummaryCard({ summary, electionName, isReplay }: { summary: NightSummary; electionName: string; isReplay: boolean }) {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {electionName}
          {isReplay ? <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">({t("night.replay")})</span> : null}
        </CardTitle>
        <CardDescription>
          {summary.minutes_since_close >= 0 ? t("night.closedAgo", { time: formatMinutes(summary.minutes_since_close) }) : t("night.notClosed")} ·{" "}
          {t("common.updated", { time: formatTimeWat(summary.updated_at) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <h3 className="mb-2 text-sm font-semibold">{t("night.progressTitle")}</h3>
        <ul className="flex flex-col gap-3">
          {summary.states.map((s) => {
            const up = share(s.uploaded, s.units);
            const canc = share(s.cancelled, s.units);
            return (
              <li key={s.state_code}>
                <div className="flex flex-wrap justify-between gap-x-3">
                  <span className="font-medium">{s.state}</span>
                  <span className="text-sm text-muted-foreground">
                    {t("night.uploadedOf", { uploaded: s.uploaded, units: s.units })} · {t("night.pendingCount", { count: s.pending })}
                    {s.cancelled ? ` · ${t("night.cancelledCount", { count: s.cancelled })}` : ""}
                  </span>
                </div>
                <div
                  className="relative mt-1 flex h-4 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${t("night.uploadedOf", { uploaded: s.uploaded, units: s.units })}, ${t("night.pendingCount", { count: s.pending })}`}
                >
                  <div style={{ width: `${up}%`, background: BUCKETS.uploaded.color }} />
                  <div style={{ width: `${canc}%`, background: BUCKETS.cancelled.color }} />
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <BucketIcon status="uploaded" size={16} /> {t("buckets.uploaded")}: {summary.totals.uploaded}
          </span>
          <span className="flex items-center gap-1.5">
            <BucketIcon status="pending" size={16} /> {t("buckets.pending")}: {summary.totals.pending}
          </span>
          <span className="flex items-center gap-1.5">
            <BucketIcon status="cancelled" size={16} /> {t("buckets.cancelled")}: {summary.totals.cancelled}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
