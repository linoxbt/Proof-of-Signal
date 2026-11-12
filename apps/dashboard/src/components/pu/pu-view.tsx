"use client";

import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { BucketBadge } from "@/components/bucket";
import { BandLegend, BandSwatch, bandFill } from "@/components/coverage/coverage-view";
import { Estimate } from "@/components/estimate";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { boundsOf } from "@/components/map/deck-map";
import { MapFrame } from "@/components/map/map-frame";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { CoverageFeatureProps, CoverageResponse, FlagClass, PointFeature, ReviewStatus } from "@/lib/api/types";
import { useReviewerSession } from "@/lib/auth/session";
import { flagClassToBucket } from "@/lib/buckets";
import { coverageBand } from "@/lib/coverage";
import { formatDistance, formatEstimate, formatMinutes } from "@/lib/format";
import { useApiData, useDemoVersion } from "@/lib/hooks";
import { haversineM, stateCodeFromPu } from "@/lib/states";

type Feature = PointFeature<CoverageFeatureProps>;
const NEIGHBOUR_RADIUS_M = 5000;
const ALL_CLASSES: FlagClass[] = ["HELD_SYSTEM_STALL", "NOT_MEASURED", "PLAUSIBLE_NETWORK", "UNEXPLAINED_DELAY", "WATCH"];
const ALL_STATUSES: ReviewStatus[] = ["unreviewed", "awaiting_second", "concern_confirmed", "explained", "dismissed"];

export function PuView({ code }: { code: string }) {
  const t = useTranslations();
  const cov = useApiData(`pu:${code}`, (s) => api.coverage(code, s));
  const state = stateCodeFromPu(code);

  if (cov.error) {
    if (cov.error instanceof ApiError && cov.error.status === 404) {
      return <ErrorBox error={new Error(t("pu.notFound"))} />;
    }
    return <ErrorBox error={cov.error} onRetry={cov.reload} />;
  }
  if (!cov.data) return <LoadingLine />;
  const c = cov.data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="font-mono text-sm text-muted-foreground">{t("pu.title", { code: c.pu_code })}</p>
        <h1 className="text-2xl font-bold sm:text-3xl">{c.name}</h1>
        <p className="text-muted-foreground">{t("pu.location", { ward: c.ward, lga: c.lga, state: c.state })}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CoverageCard c={c} />
        <HistoryCard c={c} />
      </div>
      <ReviewerFlag code={c.pu_code} state={state} />
      {state !== null ? <Neighbours c={c} state={state} /> : null}
    </div>
  );
}

function CoverageCard({ c }: { c: CoverageResponse }) {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pu.coverageTitle")}</CardTitle>
        {c.model_version ? <CardDescription>{t("pu.model", { version: c.model_version })}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <BandSwatch band={coverageBand(c.best?.p)} /> {t("common.bestCarrier")} · {t(`bands.${coverageBand(c.best?.p)}`)}
          </div>
          <Estimate p={c.best?.p} lo={c.best?.p_lo} hi={c.best?.p_hi} tests={c.best?.n_tests} measured={c.best?.measured} bar />
        </div>
        {c.carriers.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 font-medium">{t("common.carrier")}</th>
                <th className="py-2 font-medium">{t("register.chance")}</th>
                <th className="py-2 font-medium">{t("pu.testsLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {c.carriers.map((k) => (
                <tr key={`${k.mcc}-${k.mnc}`} className="border-b border-border last:border-0">
                  <td className="py-2 align-top">
                    <div className="font-medium">{k.carrier ?? `MNC ${k.mnc}`}</div>
                    <Badge variant={k.measured ? "solid" : "outline"}>{k.measured ? t("pu.measuredBadge") : t("pu.predictedBadge")}</Badge>
                  </td>
                  <td className="py-2 align-top">
                    <Estimate p={k.p} lo={k.p_lo} hi={k.p_hi} bar />
                  </td>
                  <td className="py-2 align-top text-muted-foreground">
                    {t("common.tests", { count: k.n_tests })}
                    <br />
                    {t("common.devices", { count: k.n_devices })}, {t("common.evenings", { count: k.n_evenings })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">{t("common.noPrediction")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryCard({ c }: { c: CoverageResponse }) {
  const t = useTranslations("pu");
  const tests = c.carriers.reduce((s, k) => s + k.n_tests, 0);
  const devices = Math.max(0, ...c.carriers.map((k) => k.n_devices));
  const evenings = Math.max(0, ...c.carriers.map((k) => k.n_evenings));
  const needed = Math.max(0, 3 - Math.max(0, ...c.carriers.map((k) => k.n_tests)));
  const stat = (label: string, value: number) => (
    <div className="rounded-md bg-muted p-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("history")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          {stat(t("testsLabel"), tests)}
          {stat(t("devicesLabel"), devices)}
          {stat(t("eveningsLabel"), evenings)}
        </div>
        {c.best?.measured ? (
          <Badge variant="solid" className="self-start">
            {t("measuredBadge")}
          </Badge>
        ) : (
          <p className="text-sm text-muted-foreground">{t("needMore", { count: needed })}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Reviewers also see the unit's election-night flag. The public never does. */
function ReviewerFlag({ code, state }: { code: string; state: number | null }) {
  const t = useTranslations();
  const session = useReviewerSession();
  const demoVersion = useDemoVersion();
  const token = session.status === "signed_in" ? session.token : null;
  const elections = useApiData(token ? "elections" : null, (s) => api.elections(s));
  const election = elections.data?.elections.find((e) => state === null || e.state_codes.includes(state)) ?? null;
  const flags = useApiData(
    token && election ? `pu-flags:${election.id}:${token}:${demoVersion}` : null,
    (s) => api.flags(election!.id, { classes: ALL_CLASSES, statuses: ALL_STATUSES }, token!, s),
  );
  if (!token || !election) return null;
  const flag = flags.data?.flags.find((f) => f.pu_code === code) ?? null;
  return (
    <Card data-testid="reviewer-flag">
      <CardHeader>
        <CardTitle>{t("pu.flagTitle")}</CardTitle>
        <CardDescription>{election.name}</CardDescription>
      </CardHeader>
      <CardContent>
        {flags.error ? <ErrorBox error={flags.error} onRetry={flags.reload} /> : null}
        {flags.loading && !flags.data ? <LoadingLine /> : null}
        {flags.data && !flag ? <p className="text-muted-foreground">{t("pu.noFlag")}</p> : null}
        {flag ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <BucketBadge status={flagClassToBucket(flag.class)} />
              <span className="font-medium">{t(`review.classes.${flag.class}`)}</span>
              <span className="text-sm text-muted-foreground">· {t(`review.statuses.${flag.review_status}`)}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("review.pendingFor", { time: formatMinutes(flag.evidence.minutes_pending) })} · {t("common.bestCarrier")}:{" "}
              {formatEstimate(flag.evidence.p_best, flag.evidence.p_best_lo, flag.evidence.p_best_hi)} ·{" "}
              {t("common.tests", { count: flag.evidence.n_tests })}
            </p>
            {flag.class === "UNEXPLAINED_DELAY" || flag.class === "WATCH" ? (
              <Link
                href={`/review?flag=${encodeURIComponent(flag.id)}&election=${encodeURIComponent(election.id)}`}
                className="inline-flex min-h-12 items-center font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("pu.openReview")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Neighbours({ c, state }: { c: CoverageResponse; state: number }) {
  const t = useTranslations();
  const map = useApiData(`cov:${state}:`, (s) => api.mapCoverage(state, undefined, s));
  const here: [number, number] | null = c.lat !== null && c.lng !== null ? [c.lng, c.lat] : null;

  const near = useMemo(() => {
    if (!here || !map.data) return [];
    return map.data.features
      .map((f) => ({ f, d: haversineM(here, f.geometry.coordinates) }))
      .filter((x) => x.d <= NEIGHBOUR_RADIUS_M)
      .sort((a, b) => a.d - b.d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.data, c.lat, c.lng]);

  const layers = useMemo(
    () => [
      new ScatterplotLayer<{ f: Feature; d: number }>({
        id: "neighbours",
        data: near,
        getPosition: (x) => x.f.geometry.coordinates,
        getFillColor: (x) => bandFill(x.f.properties.p_best),
        getLineColor: (x) => (x.f.properties.pu_code === c.pu_code ? [17, 24, 39, 255] : [51, 65, 85, 255]),
        getLineWidth: (x) => (x.f.properties.pu_code === c.pu_code ? 4 : 1.5),
        getRadius: (x) => (x.f.properties.pu_code === c.pu_code ? 13 : 8),
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        pickable: true,
      }),
    ],
    [near, c.pu_code],
  );
  const bounds = useMemo(() => boundsOf(near.map((x) => x.f.geometry.coordinates)), [near]);
  const tooltip = (info: PickingInfo) => {
    const x = info.object as { f: Feature; d: number } | undefined;
    if (!x) return null;
    const p = x.f.properties;
    return `${p.name}\n${t(`bands.${coverageBand(p.p_best)}`)}: ${formatEstimate(p.p_best, p.p_lo, p.p_hi)} · ${t("common.tests", { count: p.n_tests })}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pu.neighbourMap")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!here ? <p className="text-muted-foreground">{t("pu.noPoint")}</p> : null}
        {map.error ? <ErrorBox error={map.error} onRetry={map.reload} /> : null}
        {here ? (
          <>
            <MapFrame className="h-80" layers={layers} bounds={bounds} ariaLabel={t("pu.neighbourMap")} getTooltip={tooltip} />
            <BandLegend />
            <ul className="divide-y divide-border">
              {near
                .filter((x) => x.f.properties.pu_code !== c.pu_code)
                .slice(0, 8)
                .map(({ f, d }) => (
                  <li key={f.properties.pu_code}>
                    <Link
                      href={`/pu/${encodeURIComponent(f.properties.pu_code)}`}
                      className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 py-2 hover:bg-muted"
                    >
                      <BandSwatch band={coverageBand(f.properties.p_best)} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{f.properties.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {f.properties.pu_code} · {formatDistance(d)}
                        </span>
                      </span>
                      <Estimate p={f.properties.p_best} lo={f.properties.p_lo} hi={f.properties.p_hi} tests={f.properties.n_tests} />
                    </Link>
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
