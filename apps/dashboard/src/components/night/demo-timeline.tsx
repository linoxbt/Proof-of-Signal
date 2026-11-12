"use client";

import { ChevronLeft, ChevronRight, FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { IS_DEMO } from "@/lib/config";
import { NIGHT_STEPS } from "@/lib/demo/fixtures";
import { demoStore } from "@/lib/demo/store";
import { useDemoStep } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Step through the synthetic election night (demo mode only). */
export function DemoTimeline() {
  const t = useTranslations("demo");
  const step = useDemoStep();
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the current step visible on narrow screens (scroll the strip only, not the page).
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[step] as HTMLElement | undefined;
    if (list && item) list.scrollLeft = item.offsetLeft - list.offsetLeft - (list.clientWidth - item.clientWidth) / 2;
  }, [step]);
  if (!IS_DEMO) return null;
  const set = (s: number) => {
    demoStore.setStep(s);
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(demoStore.getStep()));
    window.history.replaceState(null, "", url);
  };
  return (
    <section aria-label={t("timeline")} className="rounded-lg border-2 border-dashed border-notice-border bg-notice/60 p-3" data-testid="demo-timeline">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-notice-foreground">
        <FlaskConical className="size-4" aria-hidden="true" />
        {t("timeline")} — {t("banner")}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label={t("prev")} onClick={() => set(step - 1)} disabled={step === 0}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <ol ref={listRef} className="flex flex-1 gap-1 overflow-x-auto">
          {NIGHT_STEPS.map((s, i) => (
            <li key={s.key} className="min-w-24 flex-1">
              <button
                type="button"
                onClick={() => set(i)}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "flex min-h-12 w-full flex-col items-center justify-center rounded-md border px-2 py-1 text-center text-xs leading-tight sm:text-sm",
                  i === step ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted",
                )}
              >
                <span className="font-semibold">{t(`steps.${s.key}`)}</span>
                <span className={i === step ? "opacity-90" : "text-muted-foreground"}>+{s.minutes} min</span>
              </button>
            </li>
          ))}
        </ol>
        <Button variant="outline" size="icon" aria-label={t("next")} onClick={() => set(step + 1)} disabled={step === NIGHT_STEPS.length - 1}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
