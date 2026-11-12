"use client";

import { Antenna } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "./language-switcher";

const LINKS = [
  { href: "/", key: "coverage" },
  { href: "/night", key: "night" },
  { href: "/register", key: "register" },
  { href: "/review", key: "review" },
  { href: "/method", key: "method" },
] as const;

export function SiteHeader() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-3 pt-2 sm:px-6">
        <Link href="/" className="flex min-h-12 items-center gap-2 text-lg font-bold text-primary">
          <Antenna className="size-6" aria-hidden="true" />
          {t("brand")}
        </Link>
        <LanguageSwitcher />
      </div>
      <nav aria-label={t("menu")} className="mx-auto max-w-7xl overflow-x-auto px-1 sm:px-4">
        <ul className="flex min-w-max gap-1">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center border-b-3 px-3 text-sm font-medium sm:text-base",
                    active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(l.key)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
