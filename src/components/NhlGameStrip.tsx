"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import { espnCode } from "@/lib/nhlTeams";
import type { NhlDayGame } from "@/lib/data";

const code = (t: string) => (espnCode(t) ?? t.slice(0, 3)).toUpperCase();

/** "Mon, Oct 12" from an Eastern-time day key ("2026-10-12"). */
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** A strip of every game on this schedule day, to hop between games without going back to the board. Left/right arrow keys
 * step through the day's games; the end arrows jump to the previous/next game day. */
export default function NhlGameStrip({
  currentId,
  day,
  games,
  prevGameId,
  nextGameId,
  prevDay,
  nextDay,
}: {
  currentId: number;
  day: string;
  games: NhlDayGame[];
  prevGameId: number | null;
  nextGameId: number | null;
  prevDay: string | null;
  nextDay: string | null;
}) {
  const router = useRouter();
  const idx = games.findIndex((g) => g.id === currentId);
  const rail = useRef<HTMLDivElement>(null);

  // keep the current game in view when the day has more games than fit
  useEffect(() => {
    rail.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [currentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") {
        const next = idx >= 0 && idx < games.length - 1 ? games[idx + 1].id : nextGameId;
        if (next !== null) router.push(`/nhl/games/${next}`);
      } else if (e.key === "ArrowLeft") {
        const prev = idx > 0 ? games[idx - 1].id : prevGameId;
        if (prev !== null) router.push(`/nhl/games/${prev}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, games, nextGameId, prevGameId, router]);

  const arrow = "shrink-0 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground";
  return (
    <div className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-6 py-2">
        {prevGameId !== null && prevDay ? (
          <Link href={`/nhl/games/${prevGameId}`} prefetch={false} className={arrow} title="Previous game day">
            ‹ {dayLabel(prevDay)}
          </Link>
        ) : (
          <span className={`${arrow} opacity-30`}>‹</span>
        )}
        <div className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{dayLabel(day)}</div>
        <div ref={rail} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent" }}>
          {games.map((g) => {
            const on = g.id === currentId;
            const done = g.completed && g.home_points !== null && g.away_points !== null;
            return (
              <Link
                key={g.id}
                href={`/nhl/games/${g.id}`}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={`flex shrink-0 flex-col items-center rounded-md border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                  on ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:border-accent hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-1 font-semibold">
                  <NhlTeamLogo team={g.away_team} size={14} />
                  {code(g.away_team)}
                  <span className="font-normal text-muted">@</span>
                  <NhlTeamLogo team={g.home_team} size={14} />
                  {code(g.home_team)}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  {g.live ? "live" : done ? `F ${g.away_points}–${g.home_points}` : <LocalDateTime iso={g.start_date} options={{ hour: "numeric", minute: "2-digit" }} />}
                </span>
              </Link>
            );
          })}
        </div>
        {nextGameId !== null && nextDay ? (
          <Link href={`/nhl/games/${nextGameId}`} prefetch={false} className={arrow} title="Next game day">
            {dayLabel(nextDay)} ›
          </Link>
        ) : (
          <span className={`${arrow} opacity-30`}>›</span>
        )}
      </div>
    </div>
  );
}
