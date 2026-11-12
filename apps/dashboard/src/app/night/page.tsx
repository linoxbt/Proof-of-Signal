import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LoadingLine } from "@/components/load-state";
import { NightView } from "@/components/night/night-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("night");
  return { title: t("title") };
}

export default function NightPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NightView />
    </Suspense>
  );
}
