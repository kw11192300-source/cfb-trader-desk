import { buildMarginScenarios } from "@/lib/position";
import type { Bet, Game } from "@/lib/types";

function fmtLine(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function fmtProfit(n: number): string {
  return n > 0 ? `+${n.toFixed(2)}u` : `${n.toFixed(2)}u`;
}

/** Combined net-P&L-by-outcome view for every spread/moneyline bet you've
 * logged on ONE game - the "what actually happens across outcomes" view
 * for a middled/hedged/opposite-sides position. Only worth showing once
 * there are 2+ such bets on the game; a single bet's outcome is already
 * covered by its own win/loss status everywhere else. */
export default function PositionScenarios({ bets, game }: { bets: Bet[]; game: Game }) {
  const spreadOrMlBets = bets.filter((b) => b.market !== "total");
  const totalBets = bets.filter((b) => b.market === "total");
  if (spreadOrMlBets.length < 2) return null;

  const scenarios = buildMarginScenarios(spreadOrMlBets, game);
  const best = Math.max(...scenarios.map((s) => s.netProfit));
  const worst = Math.min(...scenarios.map((s) => s.netProfit));

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface p-6">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-muted">Your position</h2>
      <p className="mb-3 text-xs text-muted">
        Net profit across every spread/moneyline bet you&apos;ve logged on this game, by how it actually finishes.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {spreadOrMlBets.map((b) => (
          <span key={b.id} className="rounded-md bg-surface-raised px-2.5 py-1.5 font-mono text-xs text-foreground">
            {b.side} {b.market === "moneyline" ? "ML" : fmtLine(b.line)} · {b.stake.toFixed(2)}u @ {b.odds > 0 ? "+" : ""}
            {b.odds}
          </span>
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.label} className="border-b border-border last:border-0 odd:bg-surface-raised/50">
                <td className="px-3 py-2 text-foreground">{s.label}</td>
                <td
                  className={`px-3 py-2 text-right font-mono font-medium ${
                    s.netProfit === best ? "text-up" : s.netProfit === worst ? "text-down" : "text-foreground"
                  }`}
                >
                  {fmtProfit(s.netProfit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalBets.length > 0 && (
        <p className="mt-3 text-[11px] text-muted">
          You also have {totalBets.length} total bet{totalBets.length === 1 ? "" : "s"} on this game — not shown above, since a
          total&apos;s outcome depends on combined points scored, not the margin.
        </p>
      )}
    </div>
  );
}
