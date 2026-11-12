"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES, LOCALE_COOKIE, LOCALE_NAMES } from "@/i18n/locales";

export function LanguageSwitcher() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <label className="relative flex items-center">
      <span className="sr-only">{t("language")}</span>
      <Languages className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden="true" />
      <select
        className="min-h-12 rounded-md border border-input bg-card py-0 pr-3 pl-9 text-sm"
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
          startTransition(() => router.refresh());
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
