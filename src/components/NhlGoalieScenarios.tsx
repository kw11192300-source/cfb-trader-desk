import { fmtOdds, pct } from "@/lib/nhlModel";
import type { ScenarioRow } from "@/lib/nhlScenarios";

const rating = (r: number | null) => (r === null ? "" : ` (${r > 0 ? "+" : ""}${r.toFixed(2)})`);

/** "+1.4" next to a percentage: how many points it moved from the modeled row (blank within 0.05). */
function Delta({ pts }: { pts: number }) {
  if (Math.abs(pts) < 0.05) return null;
  return <span className={`ml-1 ${pts > 0 ? "text-accent" : "text-warn"}`}>{pts > 0 ? "+" : ""}{pts.toFixed(1)}</span>;
}

/** The game re-run for each plausible goalie pairing: moneyline prices, win probability, expected total and the over/under at
 * 5.5, 6 and 6.5, each with its change from the modeled row and the fair over/under prices. */
export default function NhlGoalieScenarios({ rows, home, away }: { rows: ScenarioRow[]; home: string; away: string; bookTotal?: number | null }) {
  if (rows.length === 0) return <p className="text-xs text-muted">No simulation inputs saved for this game, so scenarios can&apos;t be run.</p>;
  const base = rows[0];
  const nick = (t: string) => t.split(" ").slice(-1)[0];
  const lines = base.totals.map((t) => t.line);
  const fmtLine = (l: number) => (l % 1 === 0 ? l.toFixed(0) : l.toFixed(1));
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-3 py-1.5 text-left font-medium">{nick(away)} goalie</th>
              <th className="px-3 py-1.5 text-left font-medium">{nick(home)} goalie</th>
              <th className="px-3 py-1.5 text-right font-medium">{nick(away)} ML</th>
              <th className="px-3 py-1.5 text-right font-medium">{nick(home)} ML</th>
              <th className="px-3 py-1.5 text-right font-medium">{nick(home)} win</th>
              <th className="px-3 py-1.5 text-right font-medium">Exp. total</th>
              {lines.map((l) => (
                <th key={l} className="px-3 py-1.5 text-right font-medium" title="Chance of the over, pushes refunded; the small prices are the fair over / under">
                  Over {fmtLine(l)}
                </th>
              ))}
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
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fmtOdds(r.awayOdds)}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fmtOdds(r.homeOdds)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">
                    {pct(r.pHome)}
                    {!r.asModeled && <Delta pts={dWin} />}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{r.expTotal.toFixed(2)}</td>
                  {r.totals.map((t, i) => {
                    const d = (t.over - base.totals[i].over) * 100;
                    return (
                      <td key={t.line} className="px-3 py-1.5 text-right font-mono text-foreground">
                        <div>
                          {pct(t.over)}
                          {!r.asModeled && <Delta pts={d} />}
                        </div>
                        <div className="text-[10px] text-muted">
                          {fmtOdds(t.overOdds)}/{fmtOdds(t.underOdds)}
                        </div>
                      </td>
                    );
                  })}
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
        re-simulates the game with that pairing in net; the small number beside a percentage is the change from the modeled row, and the small prices under each
        over are the fair over / under (whole-number totals refund a push, so they&apos;re priced without it). If an edge only exists in pairings you
        don&apos;t expect, it isn&apos;t one.
      </p>
    </div>
  );
}
