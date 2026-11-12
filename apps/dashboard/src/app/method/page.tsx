import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MethodData } from "@/components/method-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("method");
  return { title: t("title") };
}

const STEPS = ["measure", "predict", "freeze", "night", "review"] as const;
const LIMITS = ["bvas", "coverage", "sample", "finding", "votes"] as const;

export default async function MethodPage() {
  const t = await getTranslations("method");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">{t("title")}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t("intro")}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {STEPS.map((s) => (
          <Card key={s}>
            <CardHeader>
              <CardTitle>{t(`${s}Title`)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="leading-relaxed">{t(`${s}Body`)}</p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader>
            <CardTitle>{t("limitsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5">
              {LIMITS.map((l) => (
                <li key={l}>{t(`limits.${l}`)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <MethodData />
    </div>
  );
}
