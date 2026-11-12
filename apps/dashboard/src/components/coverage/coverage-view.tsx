"use client";

import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Estimate } from "@/components/estimate";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { boundsOf } from "@/components/map/deck-map";
import { MapFrame } from "@/components/map/map-frame";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Segmented, Select } from "@/components/ui/field";
import { api } from "@/lib/api";
import type { CoverageFeatureProps, LgaProgress, PointFeature, PuSearchUnit } from "@/lib/api/types";
import { DEFAULT_STATE_CODE } from "@/lib/config";
import { BAND_COLORS, BAND_ORDER, BAND_STROKE, CARRIERS, carrierName, coverageBand, hexToRgb, type CoverageBand } from "@/lib/coverage";
import { formatEstimate } from "@/lib/format";
import { aggregateHexes, type HexCell } from "@/lib/hex";
import { useApiData } from "@/lib/hooks";
import { stateOptions } from "@/lib/states";
import { cn } from "@/lib/utils";

type ViewMode = "dots" | "hexes";
type EvidenceMode = "all" | "measured" | "predicted";
type Feature = PointFeature<CoverageFeatureProps>;
type Rgba = [number, number, number, number];

export function BandSwatch({ band, className }: { band: CoverageBand; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-4 shrink-0 rounded-full border-2", band === "none" && "border-dashed", className)}
      style={{ background: BAND_COLORS[band], borderColor: BAND_STROKE }}
    />
  );
}

export function BandLegend() {
  const t = useTranslations("bands");
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {BAND_ORDER.map((b) => (
        <li key={b} className="flex items-center gap-2">
          <BandSwatch band={b} />
          {t(b)}
        </li>
      ))}
    </ul>
  );
}

export function bandFill(v: number | null): Rgba {
  return [...hexToRgb(BAND_COLORS[coverageBand(v)]), v === null ? 140 : 235] as Rgba;
}

const STROKE: Rgba = [...hexToRgb(BAND_STROKE), 255] as Rgba;

export function CoverageView() {
  const t = useTranslations();
  const [state, setState] = useState(DEFAULT_STATE_CODE);
  const [lga, setLga] = useState<string>("");
  const [view, setView] = useState<ViewMode>("dots");
  const [evidence, setEvidence] = useState<EvidenceMode>("all");
  const [carrier, setCarrier] = useState<string>("best");
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const lgaNum = lga ? Number(lga) : undefined;
  const map = useApiData(`cov:${state}:${lga}`, (s) => api.mapCoverage(state, lgaNum, s));
  const progress = useApiData(`prog:${state}`, (s) => api.mapProgress(state, s));

  const valueOf = useMemo(
    () => (p: CoverageFeatureProps) => (carrier === "best" ? p.p_best : (p.carriers[carrier] ?? null)),
    [carrier],
  );

  const features = useMemo(() => {
    const all = map.data?.features ?? [];
    return all.filter((f) => (evidence === "all" ? true : evidence === "measured" ? f.properties.measured : !f.properties.measured));
  }, [map.data, evidence]);

  const bounds = useMemo(() => boundsOf((map.data?.features ?? []).map((f) => f.geometry.coordinates)), [map.data]);
  const hexes = useMemo(() => aggregateHexes(features, valueOf), [features, valueOf]);
  const selectedFeature = features.find((f) => f.properties.pu_code === selected) ?? null;

  const layers = useMemo(() => {
    if (view === "hexes") {
      return [
        new H3HexagonLayer<HexCell>({
          id: "hexes",
          data: hexes,
          getHexagon: (d) => d.hex,
          getFillColor: (d) => bandFill(d.best?.p ?? null),
          getLineColor: STROKE,
          lineWidthUnits: "pixels",
          getLineWidth: 1,
          extruded: false,
          pickable: true,
          onClick: (info) => {
            if (info.object?.best) setSelected(info.object.best.pu_code);
          },
          updateTriggers: { getFillColor: [carrier] },
        }),
      ];
    }
    return [
      new ScatterplotLayer<Feature>({
        id: "units",
        data: features,
        getPosition: (d) => d.geometry.coordinates,
        getFillColor: (d) => bandFill(valueOf(d.properties)),
        getLineColor: (d) => (d.properties.pu_code === selected ? [17, 24, 39, 255] : STROKE),
        getLineWidth: (d) => (d.properties.pu_code === selected ? 3 : d.properties.measured ? 2 : 1),
        getRadius: (d) => (d.properties.pu_code === selected ? 11 : 8),
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        pickable: true,
        onClick: (info) => {
          if (info.object) setSelected(info.object.properties.pu_code);
        },
        updateTriggers: { getFillColor: [carrier], getLineColor: [selected], getLineWidth: [selected], getRadius: [selected] },
      }),
    ];
  }, [view, hexes, features, carrier, selected, valueOf]);

  const tooltip = (info: PickingInfo) => {
    const o = info.object as Feature | HexCell | undefined;
    if (!o) return null;
    if ("hex" in o) {
      const best = o.best;
      return `${t("common.units", { count: o.units })}\n${t(`bands.${coverageBand(best?.p ?? null)}`)}${
        best && carrier === "best" ? `: ${formatEstimate(best.p, best.p_lo, best.p_hi)} · ${t("common.tests", { count: best.n_tests })}` : ""
      }`;
    }
    const p = o.properties;
    const band = t(`bands.${coverageBand(valueOf(p))}`);
    return `${p.name}\n${carrier === "best" ? "" : `${carrierName(carrier)}: `}${band}\n${t("common.bestCarrier")}: ${formatEstimate(
      p.p_best,
      p.p_lo,
      p.p_hi,
    )} · ${t("common.tests", { count: p.n_tests })}`;
  };

  const sorted = useMemo(
    () =>
      [...features].sort(
        (a, b) => (valueOf(a.properties) ?? 2) - (valueOf(b.properties) ?? 2) || a.properties.pu_code.localeCompare(b.properties.pu_code),
      ),
    [features, valueOf],
  );
  const listed = showAll ? sorted : sorted.slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">{t("coverage.title")}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t("coverage.intro")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="state">{t("common.state")}</Label>
          <Select
            id="state"
            value={state}
            onChange={(e) => {
              setState(Number(e.target.value));
              setLga("");
              setSelected(null);
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
          <Label htmlFor="lga">{t("common.lga")}</Label>
          <Select
            id="lga"
            value={lga}
            onChange={(e) => {
              setLga(e.target.value);
              setSelected(null);
            }}
          >
            <option value="">{t("common.allLgas")}</option>
            {(progress.data?.lgas ?? []).map((l) => (
              <option key={l.lga_code} value={l.lga_code}>
                {l.lga}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="carrier">{t("coverage.carrierFilter")}</Label>
          <Select id="carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            <option value="best">{t("common.allCarriers")}</option>
            {CARRIERS.map((c) => (
              <option key={c.mnc} value={String(c.mnc)}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <PuSearch />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Segmented
          name="evidence"
          label={t("coverage.evidence")}
          value={evidence}
          onChange={setEvidence}
          options={[
            { value: "all", label: t("coverage.all") },
            { value: "measured", label: t("coverage.measuredOnly") },
            { value: "predicted", label: t("coverage.predictedOnly") },
          ]}
        />
        <Segmented
          name="view"
          label={t("coverage.view")}
          value={view}
          onChange={setView}
          options={[
            { value: "dots", label: t("coverage.dots") },
            { value: "hexes", label: t("coverage.hexes") },
          ]}
        />
      </div>
      {carrier !== "best" ? <p className="text-sm text-muted-foreground">{t("coverage.carrierNote")}</p> : null}

      {map.error ? <ErrorBox error={map.error} onRetry={map.reload} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-2">
          <MapFrame className="h-[55vh] min-h-72 lg:h-[32rem]" layers={layers} bounds={bounds} ariaLabel={t("coverage.title")} getTooltip={tooltip} />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("coverage.chance")}</span>
            <BandLegend />
          </div>
        </div>
        <Card aria-live="polite">
          <CardContent className="pt-4 sm:pt-5">
            {map.loading && !map.data ? <LoadingLine /> : null}
            {selectedFeature ? (
              <SelectedUnit f={selectedFeature} carrier={carrier} onClose={() => setSelected(null)} />
            ) : (
              <p className="text-muted-foreground">{t("coverage.selectUnit")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("coverage.unitsTitle")}</CardTitle>
            <CardDescription>{t("common.showing", { shown: listed.length, total: sorted.length })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {listed.map((f) => {
                const p = f.properties;
                const v = valueOf(p);
                return (
                  <li key={p.pu_code}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.pu_code)}
                      className={cn(
                        "flex min-h-12 w-full flex-wrap items-start gap-x-3 gap-y-1 py-2 text-left hover:bg-muted",
                        selected === p.pu_code && "bg-accent",
                      )}
                    >
                      <BandSwatch band={coverageBand(v)} className="mt-1" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{p.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {p.pu_code} · {p.ward} · {t(`bands.${coverageBand(v)}`)}
                          {carrier !== "best" ? ` (${carrierName(carrier)})` : ""}
                        </span>
                      </span>
                      <Estimate p={p.p_best} lo={p.p_lo} hi={p.p_hi} tests={p.n_tests} className="pl-7 sm:pl-0 sm:text-right" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {sorted.length > listed.length ? (
              <button
                type="button"
                className="mt-2 min-h-12 w-full rounded-md border border-input font-medium hover:bg-muted"
                onClick={() => setShowAll(true)}
              >
                {t("common.showAll", { total: sorted.length })}
              </button>
            ) : null}
          </CardContent>
        </Card>
        <SweepProgress lgas={progress.data?.lgas} loading={progress.loading} error={progress.error} reload={progress.reload} />
      </div>
    </div>
  );
}

function SelectedUnit({ f, carrier, onClose }: { f: Feature; carrier: string; onClose: () => void }) {
  const t = useTranslations();
  const p = f.properties;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{p.name}</h2>
          <p className="text-sm text-muted-foreground">
            {p.pu_code} · {p.ward} · {p.lga}
          </p>
        </div>
        <button type="button" onClick={onClose} className="min-h-12 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted">
          {t("common.close")}
        </button>
      </div>
      <div>
        <div className="text-sm font-medium">{t("common.bestCarrier")}</div>
        <Estimate p={p.p_best} lo={p.p_lo} hi={p.p_hi} tests={p.n_tests} measured={p.measured} bar />
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {CARRIERS.filter((c) => p.carriers[String(c.mnc)] !== undefined).map((c) => {
          const band = coverageBand(p.carriers[String(c.mnc)]);
          return (
            <li key={c.mnc} className={cn("flex items-center gap-2", carrier === String(c.mnc) && "font-semibold")}>
              <BandSwatch band={band} />
              {c.name}: {t(`bands.${band}`)}
            </li>
          );
        })}
      </ul>
      <Link
        href={`/pu/${encodeURIComponent(p.pu_code)}`}
        className="inline-flex min-h-12 items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("common.viewUnit")} <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

function SweepProgress({ lgas, loading, error, reload }: { lgas?: LgaProgress[]; loading: boolean; error?: Error; reload: () => void }) {
  const t = useTranslations("coverage");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("progressTitle")}</CardTitle>
        <CardDescription>{t("progressIntro")}</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        {loading && !lgas ? <LoadingLine /> : null}
        <ul className="flex flex-col gap-4">
          {(lgas ?? []).map((l) => {
            const tested = l.units ? (l.tested / l.units) * 100 : 0;
            const measured = l.units ? (l.measured / l.units) * 100 : 0;
            const label = t("progressRow", { tested: l.tested, units: l.units, measured: l.measured });
            return (
              <li key={l.lga_code}>
                <div className="flex flex-wrap justify-between gap-x-2">
                  <span className="font-medium">{l.lga}</span>
                  <span className="text-sm text-muted-foreground">{label}</span>
                </div>
                <div className="relative mt-1 h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
                  <div className="absolute inset-y-0 left-0 bg-primary/35" style={{ width: `${tested}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${measured}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm bg-primary" aria-hidden="true" />
            {t("measuredCount")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm bg-primary/35" aria-hidden="true" />
            {t("tested")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function PuSearch() {
  const t = useTranslations("coverage");
  const [q, setQ] = useState("");
  const query = q.trim();
  const res = useApiData<{ units: PuSearchUnit[] }>(query.length >= 2 ? `search:${query}` : null, (s) => api.searchUnits(query, s));
  return (
    <div className="relative flex flex-col gap-1">
      <Label htmlFor="pu-search">{t("search")}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id="pu-search"
          className="pl-9"
          placeholder={t("searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </div>
      {query.length >= 2 && res.data ? (
        <ul className="absolute top-full z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-lg">
          {res.data.units.length === 0 ? <li className="p-3 text-sm text-muted-foreground">{t("searchNone")}</li> : null}
          {res.data.units.map((u) => (
            <li key={u.pu_code}>
              <Link href={`/pu/${encodeURIComponent(u.pu_code)}`} className="flex min-h-12 flex-col justify-center px-3 py-1 hover:bg-muted">
                <span className="font-medium">{u.name}</span>
                <span className="text-sm text-muted-foreground">
                  {u.pu_code} · {u.ward}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
