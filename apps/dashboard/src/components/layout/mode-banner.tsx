import { FlaskConical, PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import { MODE } from "@/lib/config";

/** Always visible in demo mode; impossible to miss. */
export function ModeBanner() {
  const t = useTranslations();
  if (MODE === "demo") {
    return (
      <div role="note" data-testid="demo-banner" className="border-b-2 border-notice-border bg-notice text-notice-foreground">
        <div className="mx-auto flex max-w-7xl items-start gap-2 px-3 py-2 sm:px-6">
          <FlaskConical className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p className="text-sm">
            <strong className="font-bold uppercase tracking-wide">{t("demo.banner")}</strong> — {t("demo.bannerDetail")}
          </p>
        </div>
      </div>
    );
  }
  if (MODE === "unconfigured") {
    return (
      <div role="alert" className="border-b-2 border-notice-border bg-notice text-notice-foreground">
        <div className="mx-auto flex max-w-7xl items-start gap-2 px-3 py-2 sm:px-6">
          <PlugZap className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p className="text-sm">{t("common.notConfigured")}</p>
        </div>
      </div>
    );
  }
  return null;
}
