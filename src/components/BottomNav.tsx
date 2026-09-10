"use client";

import { MoreHorizontal, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { NAV_ITEMS, SPORT_LABEL, type Sport } from "./navConfig";

function isActive(pathname: string, href: string): boolean {
  if (href === "/" || href === "/nfl") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mobile-only (below `md:`) fixed bottom tab bar - a sidebar rail
 * doesn't work at phone width, so this is a real second layout, not the
 * same component reflowed. Shows only `primary` items directly (a real
 * bottom bar can't hold CFB's full 11-item list); anything else lives
 * behind "More", the standard mobile-app overflow pattern. */
export default function BottomNav({ sport }: { sport: Sport }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV_ITEMS[sport];
  const primary = items.filter((i) => i.primary);
  const rest = items.filter((i) => !i.primary);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background md:hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-4">
            <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted">{SPORT_LABEL[sport]} · More</span>
            <button onClick={() => setOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-foreground" aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="flex flex-col gap-1 overflow-y-auto p-3">
            {rest.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm ${active ? "bg-accent/15 text-accent" : "text-foreground hover:bg-surface-raised"}`}
                >
                  <Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-border bg-surface shadow-card md:hidden">
        {primary.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={item.prefetch}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[9px] font-medium uppercase ${active ? "text-accent" : "text-muted"}`}
            >
              <Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
              <span className="max-w-full truncate">{item.label}</span>
            </Link>
          );
        })}
        {rest.length > 0 && (
          <button onClick={() => setOpen(true)} className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[9px] font-medium uppercase text-muted">
            <MoreHorizontal size={18} strokeWidth={1.75} />
            <span className="max-w-full truncate">More</span>
          </button>
        )}
      </nav>
    </>
  );
}
