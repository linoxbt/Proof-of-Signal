import { useTranslations } from "next-intl";
import { BUCKETS, BUCKET_LIST, type DisplayStatus } from "@/lib/buckets";
import { cn } from "@/lib/utils";

/** Filled circle + white glyph: the same mark as on the map. */
export function BucketIcon({ status, size = 20, className }: { status: DisplayStatus; size?: number; className?: string }) {
  const m = BUCKETS[status];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="11" fill={m.color} stroke="#ffffff" strokeWidth="1.5" />
      <path d={m.glyph} fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Icon + word, never colour alone. */
export function BucketBadge({ status, className }: { status: DisplayStatus; className?: string }) {
  const t = useTranslations("buckets");
  const m = BUCKETS[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pr-2.5 pl-1 text-sm font-medium", className)}
      style={{ borderColor: m.color }}
      data-bucket={status}
    >
      <BucketIcon status={status} size={18} />
      {t(m.labelKey)}
    </span>
  );
}

export function BucketLegend({
  counts,
  statuses,
  twoColumns = false,
}: {
  counts?: Partial<Record<DisplayStatus, number>>;
  statuses?: DisplayStatus[];
  twoColumns?: boolean;
}) {
  const t = useTranslations("buckets");
  const list = BUCKET_LIST.filter((b) => !statuses || statuses.includes(b.status));
  return (
    <ul className={cn("grid gap-3", twoColumns && "sm:grid-cols-2")} aria-label={t("legend")}>
      {list.map((b) => (
        <li key={b.status} className="flex items-start gap-2">
          <BucketIcon status={b.status} size={22} className="mt-0.5" />
          <div className="min-w-0">
            <div className="font-medium">
              {t(b.labelKey)}
              {counts && counts[b.status] !== undefined ? <span className="ml-1 text-muted-foreground">({counts[b.status]})</span> : null}
            </div>
            <div className="text-sm text-muted-foreground">{t(`explain.${b.labelKey}`)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
