import type { Game } from "@/lib/types";

/** Thin marquee strip of currently-live games, mounted above a Board's
 * game grid. Pure CSS animation (ticker-scroll, globals.css) - no JS/
 * state needed, so this stays a server component. Renders nothing when
 * nothing's live, rather than an empty bar sitting there doing nothing. */
export default function LiveTicker({ games }: { games: Game[] }) {
  const live = games.filter((g) => g.live_status);
  if (live.length === 0) return null;

  const items = live.map((g) => {
    const s = g.live_status!;
    return `${g.away_team} ${s.away_points} — ${g.home_team} ${s.home_points}${s.detail ? ` · ${s.detail}` : ""}`;
  });

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border bg-down/10 px-3 py-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-down shadow-glow-down" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-down">Live now</span>
      </div>
      <div className="overflow-hidden py-2">
        <div className="flex w-max animate-[ticker-scroll_30s_linear_infinite] gap-10 whitespace-nowrap font-mono text-xs text-foreground">
          {[...items, ...items].map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
