"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, OTHER_SPORT, SPORT_HOME, SPORT_LABEL, type Sport } from "./navConfig";

function isActive(pathname: string, href: string): boolean {
  if (href === "/" || href === "/nfl") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop-only (`md:` and up) fixed left icon rail - the structural
 * "chrome" of the terminal, deliberately drawn perfectly rectangular
 * (no radius) in contrast to the rounded content cards. Active-route
 * highlighting needs the current path, hence a client component - the
 * old top nav never had this at all. */
export default function Sidebar({ sport }: { sport: Sport }) {
  const pathname = usePathname();
  const items = NAV_ITEMS[sport];
  const other = OTHER_SPORT[sport];

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-16 flex-col items-center border-r border-border bg-surface md:flex">
      <Link
        href={SPORT_HOME[sport]}
        prefetch={false}
        className="flex h-16 w-full items-center justify-center border-b border-border font-mono text-[11px] font-bold tracking-widest text-accent"
        title={`${SPORT_LABEL[sport]} Trader Desk`}
      >
        {SPORT_LABEL[sport]}
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1 py-3">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={item.prefetch}
              title={item.label}
              className={`group relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                active ? "bg-accent/15 text-accent shadow-glow-accent" : "text-muted hover:bg-surface-raised hover:text-foreground"
              }`}
            >
              <Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
              <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-foreground opacity-0 shadow-card transition-opacity group-hover:opacity-100">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col items-center gap-3 border-t border-border py-3">
        <Link
          href={SPORT_HOME[other]}
          title={`Switch to ${SPORT_LABEL[other]}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border font-mono text-[10px] font-semibold text-muted transition-colors hover:border-accent hover:text-foreground"
        >
          {SPORT_LABEL[other]}
        </Link>
        <span className="h-2 w-2 rounded-full bg-up shadow-glow-up" title="Live" />
      </div>
    </aside>
  );
}
