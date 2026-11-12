"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";

export function LoadingLine({ className }: { className?: string }) {
  const t = useTranslations("common");
  return (
    <p className={`flex items-center gap-2 text-muted-foreground ${className ?? ""}`} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {t("loading")}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const t = useTranslations("common");
  const notConfigured = error instanceof ApiError && error.code === "not_configured";
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-notice-border bg-notice p-4 text-notice-foreground">
      <p className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <span>{notConfigured ? t("notConfigured") : t("error", { message: error.message })}</span>
      </p>
      {onRetry && !notConfigured ? (
        <Button variant="outline" onClick={onRetry} className="self-start">
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}
