import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import LocalDateTime from "@/components/LocalDateTime";
import { getNhlEdgeLog, getNhlGoalieCalls, getNhlGoalieNews } from "@/lib/data";
import { summarizeNews, type NewsEvent } from "@/lib/nhlGoalieNews";
import { pct } from "@/lib/nhlModel";
import { byEvBucket, byMarket, calibration, goalieCallGroups, summarize, type Group, type GoalieCallGroup } from "@/lib/nhlPerformance";

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
                <td className={`px-3 py-2 text-right font-mono font-semibold ${g.n === 0 ? "text-muted" : g.roi > 0 ? "text-up" : "text-down"}`}>
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

function GoalieCallTable({ groups }: { groups: GoalieCallGroup[] }) {
  const f = (n: number | null, pctOut = true) => (n === null ? "—" : pctOut ? pct(n) : n.toFixed(3));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">What we knew</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium" title="How often the goalie we rated most likely was the one who started">
              Our top pick right
            </th>
            <th className="px-3 py-2 text-right font-medium" title="How often ESPN's named goalie started">
              ESPN right
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Average probability we put on the goalie who actually started">
              Avg. prob. on actual
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Lower is better; a coin flip between two goalies is 0.693">
              Log loss
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.label} className="border-b border-border last:border-0 odd:bg-surface/50">
              <td className="px-3 py-2 text-foreground">{g.label}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{g.n}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{f(g.topHit)}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{f(g.espnHit)}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{f(g.avgP)}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{f(g.logLoss, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The one-glance answer: the model's positive-EV sides at the first sighting - did the price move our way, and did they pay? */
function Headline({ g }: { g: Group }) {
  const CLV_TARGET = 200;
  const verdict =
    g.clv === null || g.clvN < 30
      ? `Too early to say - ${g.clvN} of about ${CLV_TARGET} closing-line samples needed.`
      : g.clv - 2 * g.clvSe > 0
        ? "The price is moving our way: the model is beating the close."
        : g.clv + 2 * g.clvSe < 0
          ? "The market is moving against our picks - the model is not beating the close."
          : "No clear signal either way yet - the average move is inside its margin of error.";
  const stat = (label: string, value: string, tone = "text-foreground", sub?: string) => (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Headline - positive-EV sides at first sighting</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Bets graded", String(g.n), "text-foreground", `${g.wins} won`)}
        {stat("ROI (flat 1u)", g.n ? `${signed(g.roi * 100)}%` : "—", g.roi > 0 ? "text-up" : "text-down", `± ${(g.roiSe * 100).toFixed(1)} (1 SE)`)}
        {stat(
          "Avg. closing-line value",
          g.clv === null ? "—" : `${signed(g.clv, 2)} pts`,
          g.clv === null ? "text-foreground" : g.clv > 0 ? "text-up" : "text-down",
          g.clv === null ? undefined : `± ${g.clvSe.toFixed(2)} (1 SE), n=${g.clvN}`,
        )}
        {stat("Beat the close", g.clvPositive === null ? "—" : pct(g.clvPositive, 0), "text-foreground", "share of picks whose price improved")}
      </div>
      <p className="mt-2 max-w-4xl text-xs text-muted">
        {verdict} Every side of every market is logged, so the all-sides total is just the book&apos;s vig - only the positive-EV slice says anything about the model.
      </p>
    </section>
  );
}

/** Does DraftKings lag our re-price when a goalie is confirmed or switched? A test that fills itself in as the season runs. */
function GoalieNews({ events }: { events: NewsEvent[] }) {
  const s = summarizeNews(events);
  const recent = events.filter((e) => e.isSwitch || Math.abs(e.modelMove) >= s.threshold).slice(0, 12);
  const f = (n: number | null, d = 1) => (n === null ? "—" : n.toFixed(d));
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Goalie news - does DraftKings lag our re-price?</h2>
      <p className="mb-2 max-w-4xl text-xs text-muted">
        Each time a goalie is confirmed (or the expected starter switches) we re-run the game within ~10 minutes. This measures how far that moved our number and
        whether DraftKings had already moved, moved afterwards, or never moved. If it often moves <span className="text-foreground">afterwards</span> on big news, there is a window worth acting in. Plain confirmations usually move us
        little because the model already assumes ESPN&apos;s expected goalie - the starter switches are the ones that matter.
      </p>
      {events.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-5 text-center text-sm text-muted">No goalie-news updates saved yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Updates", `${s.events}`, `${s.games} games`],
              ["Starter switches", `${s.switches}`, s.avgMoveSwitch === null ? "none yet" : `avg move ${f(s.avgMoveSwitch)} pts`],
              ["Plain confirmations", `${s.events - s.switches}`, s.avgMoveOther === null ? "" : `avg move ${f(s.avgMoveOther)} pts`],
              [`Moved us ≥ ${s.threshold} pt`, `${s.meaningful}`, `DK led ${s.dkLed} · with us ${s.dkWithUs} · later ${s.dkLater} · never ${s.dkNoMove}`],
            ].map(([label, value, sub]) => (
              <div key={label} className="rounded-lg border border-border bg-surface px-4 py-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
                <div className="font-mono text-lg font-semibold text-foreground">{value}</div>
                <div className="text-[11px] text-muted">{sub}</div>
              </div>
            ))}
          </div>
          {recent.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Game</th>
                    <th className="px-3 py-2 font-medium">News</th>
                    <th className="px-3 py-2 text-right font-medium" title="How far the news moved our home win probability, in points">Our move</th>
                    <th className="px-3 py-2 text-right font-medium" title="DraftKings' no-vig home probability change over the hour before we re-priced: if it already moved our way, the market knew first">DK, hour before</th>
                    <th className="px-3 py-2 text-right font-medium" title="DraftKings' no-vig home probability change in the same ~10-minute window">DK, same window</th>
                    <th className="px-3 py-2 text-right font-medium" title="DraftKings' change over the following hour (blank if the game was about to start)">DK, next hour</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => (
                    <tr key={e.key} className="border-b border-border align-top last:border-0 odd:bg-surface/50">
                      <td className="px-3 py-2 whitespace-nowrap text-muted">
                        <LocalDateTime iso={e.at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-foreground">
                        {e.away.split(" ").slice(-1)[0]} @ {e.home.split(" ").slice(-1)[0]}
                      </td>
                      <td className="px-3 py-2 text-foreground">{e.note}</td>
                      <td className={`px-3 py-2 text-right font-mono ${e.modelMove >= 0 ? "text-up" : "text-down"}`}>{signed(e.modelMove)}</td>
                      <td className="px-3 py-2 text-right font-mono text-foreground">{signed(e.dkBefore)}</td>
                      <td className="px-3 py-2 text-right font-mono text-foreground">{signed(e.dkSame)}</td>
                      <td className="px-3 py-2 text-right font-mono text-foreground">{e.dkAfter === null ? "—" : signed(e.dkAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default async function NhlPerformancePage() {
  const [{ graded, pending, games }, goalieCalls, news] = await Promise.all([getNhlEdgeLog(), getNhlGoalieCalls(), getNhlGoalieNews()]);
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

        <section className="mb-8">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">How well we call the starting goalie</h2>
          <p className="mb-2 max-w-4xl text-xs text-muted">
            Every refresh logs who we expect in net for each upcoming game - ESPN&apos;s call, our rotation model, and the blend the simulator used - and grades it
            after puck drop against who actually faced the first shot. Manual locks are excluded, so this measures our own estimate.
            {goalieCalls.pending > 0 ? ` ${goalieCalls.pending} sides are still waiting on a game.` : ""}
          </p>
          {goalieCalls.graded.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-5 text-center text-sm text-muted">
              Nothing graded yet - this fills in as logged games finish and the next model refresh runs.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1 text-[11px] text-muted">At the last look before the game</div>
                <GoalieCallTable groups={goalieCallGroups(goalieCalls.graded, "last")} />
              </div>
              <div>
                <div className="mb-1 text-[11px] text-muted">At the first sighting (earliest we had a call)</div>
                <GoalieCallTable groups={goalieCallGroups(goalieCalls.graded, "first")} />
              </div>
            </div>
          )}
        </section>

        <GoalieNews events={news} />

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

            <Headline g={summarize("All positive-EV sides", first.filter((r) => r.ev > 0))} />

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
