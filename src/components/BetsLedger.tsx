"use client";

import { useMemo, useState } from "react";
import BreakdownTable from "./BreakdownTable";
import LocalDateTime from "./LocalDateTime";
import { deleteBet } from "@/lib/actions";
import { byWeek } from "@/lib/betBreakdown";
import type { GradedBet } from "@/lib/data";
import type { DisplayLine } from "@/lib/mergedLines";
import type { Bet, Game } from "@/lib/types";

function fmtLine(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function fmtOdds(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtProfit(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

/** Closing-line value, in points, vs. the game's CURRENT line (not
 * necessarily the eventual true close - if the game hasn't kicked off yet
 * this will keep moving). Positive = the number you got is better than
 * what's available now. Spread/total only - moneyline CLV needs an
 * implied-probability conversion to be meaningful, skipped here to keep
 * this simple; the raw odds are still shown in their own column. */
function computeClv(bet: Bet, game: Game | null, currentLine: DisplayLine | null): number | null {
  if (!game || !currentLine) return null;
  if (bet.market === "spread") {
    if (currentLine.homeSpread === null) return null;
    const isHome = bet.side === game.home_team;
    const currentForSide = isHome ? currentLine.homeSpread : -currentLine.homeSpread;
    return bet.line - currentForSide;
  }
  if (bet.market === "total") {
    if (currentLine.total === null) return null;
    return bet.side === "over" ? currentLine.total - bet.line : bet.line - currentLine.total;
  }
  return null;
}

function fmtClv(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

const STATUS_STYLE: Record<string, string> = {
  win: "text-up",
  loss: "text-down",
  push: "text-muted",
  pending: "text-accent",
};

// Model = the fundamental model found this edge (today's only real source).
// Market = taken on a line move/steam read with no model edge behind it
// (future: steam alerts). Both = model edge AND market confirmed it - the
// confluence case that's supposed to size up. See bets.edge_source in schema.sql.
const SOURCE_STYLE: Record<string, string> = {
  model: "bg-accent/15 text-accent",
  market: "bg-warn/15 text-warn",
  both: "bg-up/15 text-up",
};
const SOURCE_LABEL: Record<string, string> = { model: "Model", market: "Market", both: "Both" };

type SortMode = "placed" | "kickoff";

export default function BetsLedger({ bets }: { bets: GradedBet[] }) {
  const [sortMode, setSortMode] = useState<SortMode>("kickoff");

  const sorted = useMemo(() => {
    if (sortMode === "placed") return bets; // already placed_at desc from getBets()
    // Kickoff soonest-first, but finished games drop below everything
    // still upcoming or live first - those are the ones worth seeing at a
    // glance. A bet with no game join (shouldn't normally happen) sorts
    // last of all rather than crashing the comparator.
    return [...bets].sort((a, b) => {
      if (!a.game) return 1;
      if (!b.game) return -1;
      if (a.game.completed !== b.game.completed) return a.game.completed ? 1 : -1;
      return new Date(a.game.start_date).getTime() - new Date(b.game.start_date).getTime();
    });
  }, [bets, sortMode]);

  const graded = bets.filter((b) => b.status !== "pending");
  const pendingBets = bets.filter((b) => b.status === "pending");
  const wins = graded.filter((b) => b.status === "win").length;
  const losses = graded.filter((b) => b.status === "loss").length;
  const pushes = graded.filter((b) => b.status === "push").length;

  // "Staked" counts only bets that have actually finished - a pending
  // bet's stake isn't a settled cost yet, it's still live risk, which is
  // what the separate "Pending" figure tracks (in units, not a bet count).
  const totalStaked = graded.reduce((s, b) => s + b.bet.stake, 0);
  const pendingUnits = pendingBets.reduce((s, b) => s + b.bet.stake, 0);
  const totalProfit = graded.reduce((s, b) => s + (b.profit ?? 0), 0);
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

  const byWeekRows = byWeek(graded);

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Record</div>
          <div className="font-mono text-lg text-foreground">
            {wins}-{losses}
            {pushes > 0 ? `-${pushes}` : ""}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted" title="Finished bets only">
            Staked
          </div>
          <div className="font-mono text-lg text-foreground">{totalStaked.toFixed(2)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Profit</div>
          <div className={`font-mono text-lg ${totalProfit >= 0 ? "text-up" : "text-down"}`}>{fmtProfit(totalProfit)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">ROI</div>
          <div className={`font-mono text-lg ${roi >= 0 ? "text-up" : "text-down"}`}>
            {graded.length > 0 ? `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Pending</div>
          <div className="font-mono text-lg text-accent">{pendingUnits.toFixed(2)}u</div>
          {pendingBets.length > 0 && (
            <div className="text-[10px] text-muted">
              {pendingBets.length} bet{pendingBets.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </div>

      <div className="mb-4">
        <BreakdownTable title="By week" rows={byWeekRows} />
      </div>

      {bets.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-muted">Sort:</span>
          <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
            <button
              onClick={() => setSortMode("placed")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                sortMode === "placed" ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              Recently placed
            </button>
            <button
              onClick={() => setSortMode("kickoff")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                sortMode === "kickoff" ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              Closest to kickoff
            </button>
          </div>
        </div>
      )}

      {bets.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
          No bets logged yet — click &quot;Log bet&quot; on a pick in This Week&apos;s Picks.
        </div>
      ) : (
        <div className="max-h-[65vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Placed</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Kickoff</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Bet</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right" title="Closing line value vs. the game's current line, in points">
                  CLV
                </th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Source</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Book</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Odds</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Stake</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Status</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Profit</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ bet, game, status, profit, currentLine }) => {
                const clv = computeClv(bet, game, currentLine);
                return (
                <tr key={bet.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted">
                    <LocalDateTime iso={bet.placed_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted">
                    {game ? (
                      <LocalDateTime iso={game.start_date} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-foreground">{game ? `${game.away_team} @ ${game.home_team}` : "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-foreground">
                    {bet.side} {bet.market !== "moneyline" ? fmtLine(bet.line) : ""}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${clv === null ? "text-muted" : clv >= 0 ? "text-up" : "text-down"}`}>
                    {fmtClv(clv)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${SOURCE_STYLE[bet.edge_source] ?? "text-muted"}`}>
                      {SOURCE_LABEL[bet.edge_source] ?? bet.edge_source}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted">{bet.sportsbook ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{fmtOdds(bet.odds)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-foreground">{bet.stake.toFixed(2)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium uppercase ${STATUS_STYLE[status]}`}>{status}</td>
                  <td className={`px-4 py-2.5 text-right font-mono font-medium ${profit === null ? "text-muted" : profit >= 0 ? "text-up" : "text-down"}`}>
                    {fmtProfit(profit)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <form action={deleteBet.bind(null, bet.id)}>
                      <button type="submit" className="text-xs text-muted hover:text-down" title="Remove this bet">
                        ✕
                      </button>
                    </form>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
