"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { shortHash } from "@/lib/format";

/** A hash, abbreviated on small screens, in full on wide ones, with a copy button. */
export function HashText({ value, label }: { value: string | null | undefined; label: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 font-mono text-sm break-all" title={value}>
        <span className="md:hidden">{shortHash(value)}</span>
        <span className="hidden md:inline">{value}</span>
      </code>
      <button
        type="button"
        className="inline-flex size-12 shrink-0 items-center justify-center rounded-md hover:bg-muted"
        aria-label={`${copied ? t("copied") : t("copy")}: ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
    </span>
  );
}
