import { fmtOdds, pct } from "@/lib/nhlModel";
import type { ScenarioRow } from "@/lib/nhlScenarios";

const rating = (r: number | null) => (r === null ? "" : ` (${r > 0 ? "+" : ""}${r.toFixed(2)})`);

/** The game re-run for each plausible goalie pairing: win probability, total, and the best DraftKings price in each case. */
export default function NhlGoalieScenarios({ rows, home, away, bookTotal }: { rows: ScenarioRow[]; home: string; away: string; bookTotal: number | null }) {
  if (rows.length === 0) return <p className="text-xs text-muted">No simulation inputs saved for this game, so scenarios can&apos;t be run.</p>;
  const base = rows[0];
  const nick = (t: string) => t.split(" ").slice(-1)[0];
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-3 py-1.5 text-left font-medium">{nick(away)} goalie</th>
              <th className="px-3 py-1.5 text-left font-medium">{nick(home)} goalie</th>
              <th className="px-3 py-1.5 text-right font-medium">{nick(home)} win</th>
              <th className="px-3 py-1.5 text-right font-medium">Price</th>
              <th className="px-3 py-1.5 text-right font-medium">Exp. total</th>
              {bookTotal !== null && <th className="px-3 py-1.5 text-right font-medium">Over {bookTotal}</th>}
              <th className="px-3 py-1.5 text-right font-medium" title="The DraftKings side with the highest expected value if this pairing is what plays">
                Best DK side
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dWin = (r.pHome - base.pHome) * 100;
              return (
                <tr key={r.key} className={`border-b border-border last:border-0 ${r.asModeled ? "bg-accent/10" : ""}`}>
                  <td className="px-3 py-1.5 text-foreground">
                    {r.away}
                    <span className="text-muted">{rating(r.awayRating)}</span>
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
                    {r.home}
                    <span className="text-muted">{rating(r.homeRating)}</span>
                    {r.asModeled && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-background">AS MODELED</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">
                    {pct(r.pHome)}
                    {!r.asModeled && Math.abs(dWin) >= 0.1 && <span className={`ml-1 ${dWin > 0 ? "text-accent" : "text-warn"}`}>{dWin > 0 ? "+" : ""}{dWin.toFixed(1)}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fmtOdds(r.homeOdds)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{r.expTotal.toFixed(2)}</td>
                  {bookTotal !== null && <td className="px-3 py-1.5 text-right font-mono text-foreground">{r.overAtBook === null ? "—" : pct(r.overAtBook)}</td>}
                  <td className="px-3 py-1.5 text-right font-mono">
                    {r.best ? (
                      <span className={r.best.ev > 0 ? "text-accent" : "text-muted"}>
                        {r.best.side} {fmtOdds(r.best.bookOdds)} · {r.best.ev >= 0 ? "+" : ""}
                        {(r.best.ev * 100).toFixed(1)}%
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Numbers in brackets are each goalie&apos;s model rating (goals saved above expected per 100 attempts, shrunk toward average - noisy for backups). Each row
        re-simulates the game with that pairing in net; the small number beside a win % is the change from the modeled row. If an edge only exists in
        pairings you don&apos;t expect, it isn&apos;t one.
      </p>
    </div>
  );
}
