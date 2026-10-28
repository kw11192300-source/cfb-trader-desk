"use client";

import Link from "next/link";
import type { DeskBet } from "@/lib/deskBets";
import { dayKey, gameHref, Row, short, SPORT_LABEL, SPORT_TONE, tone, units } from "./AllSportsBets";

/** The bets you have on one day (the viewer's own calendar day, `day` = YYYY-MM-DD), grouped by game in tip-time order, with a one-line
 * risked / pending / settled summary. Used on a sport's board so a day's tickets sit right above its games. Parlays span games, so they
 * are listed last under the day they were placed. Renders nothing when there are no bets that day. */
export default function DayBetsPanel({ bets, day, sport }: { bets: DeskBet[]; day: string; sport?: string }) {
  const mine = sport ? bets.filter((b) => b.sport === sport) : bets;
  const games = new Map<number, { sport: string; start: string; away: string | null; home: string | null; completed: boolean; live: boolean; liveDetail: string | null; awayPts: number | null; homePts: number | null; bets: DeskBet[] }>();
  const parlays: DeskBet[] = [];
  for (const b of mine) {
    if (b.gameId !== null && b.start && dayKey(b.start) === day) {
      const g = games.get(b.gameId) ?? { sport: b.sport, start: b.start, away: b.away, home: b.home, completed: b.completed, live: b.live, liveDetail: b.liveDetail, awayPts: b.awayPts, homePts: b.homePts, bets: [] };
      g.bets.push(b);
      games.set(b.gameId, g);
    } else if (b.market === "parlay" && b.gameId === null && dayKey(b.placedAt) === day) parlays.push(b);
  }
  const list = [...games.entries()].sort((a, b) => new Date(a[1].start).getTime() - new Date(b[1].start).getTime());
  const all = [...list.flatMap(([, g]) => g.bets), ...parlays];
  if (all.length === 0) return null;

  const staked = all.reduce((s, b) => s + b.stake, 0);
  const settled = all.filter((b) => b.status !== "pending");
  const pending = all.filter((b) => b.status === "pending");
  const net = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const wins = settled.filter((b) => b.status === "win").length;
  const losses = settled.filter((b) => b.status === "loss").length;
  const label = new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Your bets · {label}</h2>
        <span className="font-mono text-[11px] text-muted">
          {all.length} bet{all.length === 1 ? "" : "s"} · {staked.toFixed(2)}u risked
          {pending.length > 0 && <> · {pending.reduce((s, b) => s + b.stake, 0).toFixed(2)}u pending ({pending.length})</>}
          {settled.length > 0 && (
            <>
              {" "}
              · settled <span className={tone(net)}>{units(net)}</span> ({wins}-{losses}
              {settled.length - wins - losses > 0 ? `-${settled.length - wins - losses}` : ""})
            </>
          )}
        </span>
      </div>
      <div className="divide-y divide-border/60 text-xs">
        {list.map(([id, g]) => {
          const href = gameHref(g.sport, id);
          const live = g.live && !g.completed;
          const title = `${short(g.away, g.sport)} @ ${short(g.home, g.sport)}`;
          return (
            <div key={id} className="px-4 py-2.5">
              <div className="mb-0.5 flex items-baseline justify-between gap-3">
                <span className="flex items-baseline gap-2">
                  {!sport && <span className={`text-[10px] font-semibold tracking-wide ${SPORT_TONE[g.sport] ?? "text-muted"}`}>{SPORT_LABEL[g.sport] ?? g.sport.toUpperCase()}</span>}
                  {href ? (
                    <Link href={href} className="font-medium text-foreground hover:underline">
                      {title}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{title}</span>
                  )}
                </span>
                <span className={`text-[11px] ${live ? "font-medium text-down" : "text-muted"}`}>
                  {g.completed
                    ? `Final ${g.awayPts ?? "—"}-${g.homePts ?? "—"}`
                    : live
                      ? `LIVE${g.liveDetail ? ` · ${g.liveDetail}` : ""}`
                      : new Date(g.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <ul>
                {g.bets.map((b) => (
                  <Row key={b.id} b={b} />
                ))}
              </ul>
            </div>
          );
        })}
        {parlays.length > 0 && (
          <div className="px-4 py-2.5">
            <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">Parlays placed this day</div>
            <ul>
              {parlays.map((b) => (
                <Row key={b.id} b={b} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
