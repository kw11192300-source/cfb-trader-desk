import { fairOdds, fmtOdds, pct } from "@/lib/nhlModel";
import type { EdgeRow } from "@/lib/nhlEdges";

const pts = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/** Our prices against the book's for every side it has posted. A row is lit when our probability beats the book's
 * no-vig number AND the posted price pays more than our fair price (positive expected value if the model is right). */
export default function NhlMarketComparison({ rows, provider }: { rows: EdgeRow[]; provider: string | null }) {
  const book = provider ?? "the book";
  if (rows.length === 0) {
    return <p className="text-xs text-muted">No {book} lines posted for this game yet - ESPN usually has them a day or two ahead. Use Update DK odds on the board.</p>;
  }
  const best = rows.reduce((a, b) => (b.ev > a.ev ? b : a));
  const beats = best.ev > 0;

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        {beats ? (
          <>
            Largest gap: <span className="text-foreground">{best.side}</span> ({best.market.toLowerCase()}) - model {pct(best.model)} vs the {pct(best.bookImplied)} that {fmtOdds(best.bookOdds)} needs to break even, worth{" "}
            <span className="font-mono text-accent">
              {pts(best.edgePts)} pts / {best.ev >= 0 ? "+" : ""}
              {(best.ev * 100).toFixed(1)}% EV
            </span>{" "}
            at {fmtOdds(best.bookOdds)}.
          </>
        ) : (
          <>No side beats {book}&apos;s posted price by our numbers - the model agrees with the market, or only disagrees by less than the vig.</>
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-3 py-1.5 text-left font-medium">Market</th>
              <th className="px-3 py-1.5 text-left font-medium">Side</th>
              <th className="px-3 py-1.5 text-right font-medium" title="The price the book is offering">
                {book}
              </th>
              <th className="px-3 py-1.5 text-right font-medium" title="The win probability the posted price needs to break even - the vig is included">
                Break-even
              </th>
              <th className="px-3 py-1.5 text-right font-medium">Model</th>
              <th className="px-3 py-1.5 text-right font-medium" title="Our fair (no-vig) price">
                Model price
              </th>
              <th className="px-3 py-1.5 text-right font-medium" title="Model probability minus the break-even probability of the posted price">
                Edge (pts)
              </th>
              <th className="px-3 py-1.5 text-right font-medium" title="Expected profit per $1 staked at the book's price if the model is right">
                EV
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const live = r.ev > 0;
              const strong = r.ev >= 0.03;
              const newMarket = i === 0 || rows[i - 1].market !== r.market;
              return (
                <tr key={`${r.market}-${r.side}`} className={`border-b border-border last:border-0 ${live ? "bg-accent/10" : ""} ${newMarket && i > 0 ? "border-t border-t-border" : ""}`}>
                  <td className="px-3 py-1.5 text-muted">{newMarket ? r.market : ""}</td>
                  <td className="px-3 py-1.5 text-foreground">
                    {r.side}
                    {strong && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-background">EDGE</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-up">{fmtOdds(r.bookOdds)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(r.bookImplied)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(r.model)}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fairOdds(r.model)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${r.edgePts > 0 ? "text-accent" : "text-warn"}`}>{pts(r.edgePts)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${live ? "text-accent" : "text-muted"}`}>
                    {r.ev >= 0 ? "+" : ""}
                    {(r.ev * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Break-even is the win probability the posted price needs, vig included (-110 needs 52.4%). Edge = our probability minus that, so it is measured against
        the price you would actually get. EV = what a $1 bet at that price earns on average if our probability is right. Whole-number totals refund a push, so
        those are priced without it. Lit rows are where our number beats the price; EDGE marks EV of 3% or more. Our
        backtest says this model does not beat the closing line, so treat a lit row as &quot;the model disagrees with the market&quot; - often a lineup, injury or
        roster change it can&apos;t see - not as a bet.
      </p>
    </div>
  );
}
