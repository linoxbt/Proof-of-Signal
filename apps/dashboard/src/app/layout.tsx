import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { SiteHeader } from "@/components/layout/site-header";
import { ModeBanner } from "@/components/layout/mode-banner";
import { HTML_LANG, isLocale } from "@/i18n/locales";
import { ReviewerSessionProvider } from "@/lib/auth/session";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: { default: t("title"), template: `%s · ${t("title")}` }, description: t("description") };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b4a87",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("footer");
  return (
    <html lang={isLocale(locale) ? HTML_LANG[locale] : "en"} className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>
          <ReviewerSessionProvider>
            <ModeBanner />
            <SiteHeader />
            <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-6 sm:py-6">{children}</main>
            <footer className="border-t border-border bg-card">
              <div className="mx-auto max-w-7xl space-y-1 px-3 py-4 text-sm text-muted-foreground sm:px-6">
                <p>{t("about")}</p>
                {locale !== "en" ? <p>{t("translation")}</p> : null}
              </div>
            </footer>
          </ReviewerSessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
