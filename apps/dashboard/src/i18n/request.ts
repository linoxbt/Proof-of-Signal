import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import en from "../../messages/en.json";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./locales";

type Messages = { [key: string]: string | Messages };

function fromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const base = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/** English underneath, the draft translation on top: a missing key shows English, never a raw key. */
export function mergeMessages(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = typeof v === "object" && typeof b === "object" ? mergeMessages(b, v) : v;
  }
  return out;
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookie = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(cookie) ? cookie : (fromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE);
  const messages =
    locale === "en"
      ? (en as Messages)
      : mergeMessages(en as Messages, (await import(`../../messages/${locale}.json`)).default as Messages);
  return { locale, messages, timeZone: "Africa/Lagos" };
});
