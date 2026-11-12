import { useTranslations } from "next-intl";
import { formatEstimate, formatInterval, formatPercent, roundedInterval } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A probability with its interval and test count. The point value is never
 * shown without the range.
 */
export function Estimate({
  p,
  lo,
  hi,
  tests,
  measured,
  className,
  bar = false,
}: {
  p: number | null | undefined;
  lo: number | null | undefined;
  hi: number | null | undefined;
  tests?: number | null;
  measured?: boolean | null;
  className?: string;
  bar?: boolean;
}) {
  const t = useTranslations("common");
  const r = roundedInterval(p, lo, hi);
  if (!r) return <span className={cn("text-muted-foreground", className)}>{t("noPrediction")}</span>;
  return (
    <span className={cn("inline-flex flex-col gap-1", className)}>
      <span aria-label={t("estimateLabel", { value: formatPercent(p), range: formatInterval(lo, hi) })}>
        <span className="font-semibold tabular-nums">{r.p}%</span>{" "}
        <span className="text-sm text-muted-foreground tabular-nums">({r.lo}–{r.hi}%)</span>
        {tests !== undefined && tests !== null ? (
          <span className="text-sm text-muted-foreground"> · {t("tests", { count: tests })}</span>
        ) : null}
        {measured !== undefined && measured !== null ? (
          <span className="text-sm text-muted-foreground"> · {measured ? t("measured") : t("predicted")}</span>
        ) : null}
      </span>
      {bar ? <IntervalBar p={r.p} lo={r.lo} hi={r.hi} /> : null}
    </span>
  );
}

/** Horizontal bar: the likely range as a band, the estimate as a tick. */
export function IntervalBar({ p, lo, hi }: { p: number; lo: number; hi: number }) {
  return (
    <span className="relative block h-2.5 w-full max-w-56 rounded-full bg-muted" aria-hidden="true">
      <span className="absolute inset-y-0 rounded-full bg-primary/35" style={{ left: `${lo}%`, width: `${Math.max(1, hi - lo)}%` }} />
      <span className="absolute -inset-y-0.5 w-1 rounded bg-primary" style={{ left: `calc(${p}% - 2px)` }} />
    </span>
  );
}

export function estimateText(p: number | null | undefined, lo: number | null | undefined, hi: number | null | undefined): string {
  return formatEstimate(p, lo, hi);
}
