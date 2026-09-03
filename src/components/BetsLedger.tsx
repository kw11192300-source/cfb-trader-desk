"use client";

import LocalDateTime from "./LocalDateTime";
import { deleteBet } from "@/lib/actions";
import type { GradedBet } from "@/lib/data";

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

export default function BetsLedger({ bets }: { bets: GradedBet[] }) {
  const graded = bets.filter((b) => b.status !== "pending");
  const wins = graded.filter((b) => b.status === "win").length;
  const losses = graded.filter((b) => b.status === "loss").length;
  const pushes = graded.filter((b) => b.status === "push").length;
  const pending = bets.length - graded.length;

  // "Staked" is total money in play across every bet, pending included -
  // ROI is computed only against the GRADED portion, since a pending bet
  // has no known return yet and would silently drag ROI toward zero.
  const totalStaked = bets.reduce((s, b) => s + b.bet.stake, 0);
  const gradedStaked = graded.reduce((s, b) => s + b.bet.stake, 0);
  const totalProfit = graded.reduce((s, b) => s + (b.profit ?? 0), 0);
  const roi = gradedStaked > 0 ? (totalProfit / gradedStaked) * 100 : 0;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Record</div>
          <div className="font-mono text-lg text-foreground">
            {wins}-{losses}
            {pushes > 0 ? `-${pushes}` : ""}
          </div>
          {pending > 0 && <div className="text-[10px] text-muted">{pending} pending</div>}
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Staked</div>
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
      </div>

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
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Bet</th>
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
              {bets.map(({ bet, game, status, profit }) => (
                <tr key={bet.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted">
                    <LocalDateTime iso={bet.placed_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-foreground">{game ? `${game.away_team} @ ${game.home_team}` : "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-foreground">
                    {bet.side} {bet.market !== "moneyline" ? fmtLine(bet.line) : ""}
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
