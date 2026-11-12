"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { IS_DEMO } from "@/lib/config";
import { demoStore } from "@/lib/demo/store";

/** Applies `?step=N` to the demo timeline once (demo mode only). */
export function useDemoStepParam() {
  const params = useSearchParams();
  const raw = params.get("step");
  useEffect(() => {
    if (!IS_DEMO || raw === null) return;
    const n = Number(raw);
    if (Number.isInteger(n)) demoStore.setStep(n);
  }, [raw]);
}
