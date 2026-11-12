"use client";

import { MapPinOff } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { DeckMapProps } from "./deck-map";

const DeckMap = dynamic(() => import("./deck-map"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse bg-muted" />,
});

/** Client-only map with a text fallback when WebGL is unavailable. */
export function MapFrame({ className, ...props }: Omit<DeckMapProps, "onUnavailable"> & { className?: string }) {
  const t = useTranslations("common");
  const [unavailable, setUnavailable] = useState(false);
  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-border bg-[#e7ecf1]", className)}>
      {unavailable ? (
        <div className="flex size-full items-center justify-center p-6 text-center text-muted-foreground">
          <p className="flex max-w-sm flex-col items-center gap-2">
            <MapPinOff className="size-6" aria-hidden="true" />
            {t("mapUnavailable")}
          </p>
        </div>
      ) : (
        <DeckMap {...props} className="size-full" onUnavailable={() => setUnavailable(true)} />
      )}
    </div>
  );
}
