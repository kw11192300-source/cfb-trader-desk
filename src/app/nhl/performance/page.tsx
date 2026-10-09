import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlEdgeLog } from "@/lib/data";
import { pct } from "@/lib/nhlModel";
import { byEvBucket, byMarket, calibration, summarize, type Group } from "@/lib/nhlPerformance";

export const dynamic = "force-dynamic";

const signed = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

function GroupTable({ groups, firstHeader, showClv }: { groups: Group[]; firstHeader: string; showClv?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">{firstHeader}</th>
            <th className="px-3 py-2 text-right font-medium">Bets</th>
            <th className="px-3 py-2 text-right font-medium" title="Wins / (wins + losses); pushes left out">
              Win %
            </th>
            <th className="px-3 py-2 text-right font-medium">Model %</th>
            <th className="px-3 py-2 text-right font-medium" title="Average win probability the prices needed to break even">
              Break-even %
            </th>
            <th className="px-3 py-2 text-right font-medium">Avg EV</th>
            <th className="px-3 py-2 text-right font-medium" title="Profit per 1 unit staked on every bet, flat stakes, with one standard error">
              ROI (± 1 SE)
            </th>
            {showClv && (
              <th className="px-3 py-2 text-right font-medium" title="Closing line value: how much the price at the close implies more than the price we logged (points). Positive = we beat the close">
                CLV (pts)
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const decided = g.n - g.pushes;
            return (
              <tr key={g.label} className="border-b border-border last:border-0 odd:bg-surface/50">
                <td className="px-3 py-2 text-foreground">{g.label}</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">{g.n}</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">{g.n > 0 ? pct(g.wins / Math.max(decided, 1)) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">{g.n > 0 ? pct(g.avgModel) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-muted">{g.n > 0 ? pct(g.avgBreakEven) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">{g.n > 0 ? `${signed(g.avgEv * 100)}%` : "—"}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${g.n === 0 ? "text-muted" : g.roi > 0 ? "text-accent" : "text-warn"}`}>
                  {g.n > 0 ? (
                    <>
                      {signed(g.roi * 100)}% <span className="font-normal text-muted">± {(g.roiSe * 100).toFixed(1)}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                {showClv && (
                  <td className="px-3 py-2 text-right font-mono text-foreground">
                    {g.clv === null ? "—" : `${signed(g.clv, 2)}`}
                    {g.clvPositive !== null && <span className="ml-1 text-muted">({pct(g.clvPositive, 0)} beat it, n={g.clvN})</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function NhlPerformancePage() {
  const { graded, pending, games } = await getNhlEdgeLog();
  const first = graded.filter((r) => r.kind === "first");
  const close = graded.filter((r) => r.kind === "close");
  const cal = calibration(close);
  const gradedGames = new Set(close.map((r) => r.game_id)).size;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Edge log" sport="nhl" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            A season-long test of the model&apos;s edges against DraftKings, <span className="text-foreground">including the ones nobody bet</span>. Every time the odds
            update, each side of the moneyline, puck line and total is priced and logged twice: at the{" "}
            <span className="text-foreground">first sighting</span> (the first time a game has both a prediction and DraftKings lines) and at the{" "}
            <span className="text-foreground">close</span> (the last look before puck drop). After the game each is settled on the final score, at flat 1-unit stakes.
          </p>
          <p className="mt-2">
            The question: <span className="text-foreground">does higher modeled EV actually earn more?</span> Read the EV-bucket table top to bottom - if the model
            has an edge, ROI should climb as EV does. Results are very noisy: with near-even odds, ROI is only known to about ±4.5% after 500 bets and ±2.2% after
            2,000, so a real 3% edge takes a long while to show. <span className="text-foreground">CLV</span> (did the price move our way by the close?) settles much
            faster than wins and losses.
          </p>
          <p className="mt-2 text-warn/90">
            The logging started when the odds timer was switched on - nothing before that is here. Games where the model had no goalie or lineup information are
            included like any other.
          </p>
        </div>

        {graded.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
            Nothing graded yet. {games > 0 ? `${games} game${games === 1 ? "" : "s"} logged so far (${pending} waiting on a final score) - this fills in as they finish.` : "Logging starts the next time the odds update runs (the Update DK odds button, or the timer)."}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
              <span>
                <span className="font-mono text-foreground">{gradedGames}</span> games graded
              </span>
              <span>
                <span className="font-mono text-foreground">{close.length}</span> sides priced
              </span>
              <span>
                <span className="font-mono text-foreground">{pending}</span> games waiting on a result
              </span>
            </div>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Bet at the first sighting - by modeled EV</h2>
              <GroupTable groups={byEvBucket(first)} firstHeader="Bucket" showClv />
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Bet at the close - by modeled EV</h2>
              <GroupTable groups={byEvBucket(close)} firstHeader="Bucket" />
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Positive-EV sides at first sighting - by market</h2>
              <GroupTable groups={byMarket(first.filter((r) => r.ev > 0))} firstHeader="Market" showClv />
              <div className="mt-2">
                <GroupTable groups={[summarize("All positive-EV sides", first.filter((r) => r.ev > 0))]} firstHeader="Overall" showClv />
              </div>
            </section>

            {cal.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Calibration - does a 60% call win 60% of the time?</h2>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-3 py-2 font-medium">Model probability</th>
                        <th className="px-3 py-2 text-right font-medium">Sides</th>
                        <th className="px-3 py-2 text-right font-medium">Model says</th>
                        <th className="px-3 py-2 text-right font-medium">Actually won</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cal.map((c) => (
                        <tr key={c.label} className="border-b border-border last:border-0 odd:bg-surface/50">
                          <td className="px-3 py-2 text-foreground">{c.label}</td>
                          <td className="px-3 py-2 text-right font-mono text-foreground">{c.n}</td>
                          <td className="px-3 py-2 text-right font-mono text-foreground">{pct(c.model)}</td>
                          <td className="px-3 py-2 text-right font-mono text-foreground">{pct(c.actual)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
