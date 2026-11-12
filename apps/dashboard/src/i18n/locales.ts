export const LOCALES = ["en", "ha", "yo", "ig", "pcm"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Native names, shown in the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ha: "Hausa",
  yo: "Yorùbá",
  ig: "Igbo",
  pcm: "Naijá (Pidgin)",
};

/** BCP 47 tag for <html lang>. */
export const HTML_LANG: Record<Locale, string> = { en: "en-NG", ha: "ha", yo: "yo", ig: "ig", pcm: "pcm" };

export function isLocale(x: unknown): x is Locale {
  return typeof x === "string" && (LOCALES as readonly string[]).includes(x);
}
