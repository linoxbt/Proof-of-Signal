import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LoadingLine } from "@/components/load-state";
import { ReviewView } from "@/components/review/review-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("review");
  return { title: t("title"), robots: { index: false } };
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ReviewView />
    </Suspense>
  );
}
