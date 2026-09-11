"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { NAV_ITEMS, SPORT_LABEL, type Sport } from "./navConfig";

type Destination = { href: string; label: string; sport: Sport; icon: (typeof NAV_ITEMS)["cfb"][number]["icon"] };

const DESTINATIONS: Destination[] = (Object.keys(NAV_ITEMS) as Sport[]).flatMap((sport) =>
  NAV_ITEMS[sport].map((item) => ({ href: item.href, label: item.label, sport, icon: item.icon })),
);

/** Global Cmd/Ctrl+K palette - mounted once in the root layout, so it's
 * the one thing in this app that isn't scoped to a single page. The
 * first genuine keyboard-shortcut and the first real backdrop-dimmed
 * dialog in the codebase (BottomNav's "More" sheet is opaque full-bleed,
 * not a centered overlay) - z-[60] to sit above BottomNav/Sidebar's
 * z-40 and the More sheet's z-50. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return DESTINATIONS;
    return DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q) || d.sport.includes(q));
  }, [query]);

  function close() {
    setOpen(false);
    setQuery("");
    setHighlighted(0);
  }

  function go(dest: Destination) {
    router.push(dest.href);
    close();
  }

  // Global open/close shortcut - Cmd+K on Mac, Ctrl+K everywhere else.
  // Also listens for a plain DOM event so the visible ⌘K hint badge in
  // SiteHeader (no direct access to this component's state) can open it
  // the same way, without prop-drilling a toggle through every page.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-command-palette", onOpenEvent);
    };
  }, []);

  // Reset the highlighted row exactly when `open` flips true - done
  // during render via React's own documented "adjusting state when a
  // prop changes" pattern (a state variable tracking the previous value,
  // not a ref - refs can't be read/written during render either) rather
  // than in an effect, since a setState call that only ever mirrors a
  // state transition like this belongs there, not in an effect meant for
  // syncing with the DOM/an external system. The actual DOM focus call
  // below IS that kind of external-system interaction, so it stays in
  // its own effect with no setState.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setHighlighted(0);
  }

  useEffect(() => {
    if (open) {
      // Wait a tick for the input to mount before focusing it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const dest = results[highlighted];
      if (dest) go(dest);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[15vh]" onClick={close}>
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to…"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
          />
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">ESC</span>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted">No matches.</div>
          ) : (
            results.map((dest, i) => {
              const Icon = dest.icon;
              return (
                <button
                  key={`${dest.sport}-${dest.href}`}
                  onClick={() => go(dest)}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                    i === highlighted ? "bg-accent/15 text-accent" : "text-foreground"
                  }`}
                >
                  <Icon size={16} strokeWidth={i === highlighted ? 2.25 : 1.75} />
                  <span className="flex-1">{dest.label}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted">{SPORT_LABEL[dest.sport]}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
