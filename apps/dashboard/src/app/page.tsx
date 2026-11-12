import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CoverageView } from "@/components/coverage/coverage-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coverage");
  return { title: t("title") };
}

export default function CoveragePage() {
  return <CoverageView />;
}
