import GoalieLock from "./GoalieLock";
import LocalDateTime from "./LocalDateTime";
import NhlMarketComparison from "./NhlMarketComparison";
import NhlTeamLogo from "./NhlTeamLogo";
import NhlWinBar from "./NhlWinBar";
import NhlYourLine from "./NhlYourLine";
import ProbOdds from "./ProbOdds";
import ScoreGrid from "./ScoreGrid";
import { matchupColors } from "@/lib/nhlColors";
import { marketEdges } from "@/lib/nhlEdges";
import { fairOdds, mostLikelyScore, overUnder, pct, puckLineCover } from "@/lib/nhlModel";
import type { Game, NhlGameXg, NhlPrediction } from "@/lib/types";

const TOTAL_LINES = Array.from({ length: 11 }, (_, i) => 4 + i * 0.5); // 4, 4.5 ... 9
const PUCK_LINES = [-2.5, -1.5, 1.5, 2.5]; // the home team's handicap; the away team's is the opposite sign
const signed = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {note && <span className="text-[11px] text-muted">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Cell({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <td className={`px-3 py-1.5 text-right font-mono text-xs ${strong ? "font-semibold text-foreground" : "text-foreground"}`}>{children}</td>;
}

export default function NhlGameView({ game, prediction, xg }: { game: Game; prediction: NhlPrediction | null; xg: NhlGameXg | null }) {
  const home = game.home_team;
  const away = game.away_team;
  const done = game.completed && game.home_points !== null && game.away_points !== null;
  const m = prediction?.market ?? null;
  const colors = matchupColors(home, away);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
          <LocalDateTime iso={game.start_date} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          <span>{done ? "FINAL" : game.live_status ? "LIVE" : "Upcoming"}</span>
        </div>
        <div className="mt-3 flex items-center justify-between text-lg">
          <span className="flex items-center gap-3 text-foreground">
            <NhlTeamLogo team={away} size={36} />
            {away}
          </span>
          {done && <span className="font-mono font-semibold text-foreground">{game.away_points}</span>}
        </div>
        <div className="flex items-center justify-between text-lg">
          <span className="flex items-center gap-3 text-foreground">
            <NhlTeamLogo team={home} size={36} />
            {home}
          </span>
          {done && <span className="font-mono font-semibold text-foreground">{game.home_points}</span>}
        </div>
      </div>

      {!prediction ? (
        done ? null : (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">
            No model prediction for this game yet. Predictions are published by <code className="text-foreground">python -m nhl_model.publish</code> for
            games in the next few days.
          </div>
        )
      ) : (
        <>
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-[11px] leading-relaxed text-muted">
            <span className="font-semibold text-warn">Baseline, not a betting signal.</span> Backtested on 2021–25, this model is calibrated but does
            <em> not </em>beat the market&apos;s closing line on moneyline, puck line, or totals. Use it as a fair-price reference to hold the market
            against - and remember it knows nothing about injuries, lineup changes or off-season roster moves.
          </div>

          <Card title="Win probability" note={`${(prediction.extras?.n_sims ?? 0).toLocaleString()} simulations · ${prediction.model_version}`}>
            <NhlWinBar
              home={home}
              away={away}
              homeColor={colors.home}
              awayColor={colors.away}
              pHome={prediction.p_home}
              pHomeReg={prediction.p_home_reg}
              pTieReg={prediction.p_tie_reg}
            />
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <div className="text-muted">Win in regulation</div>
                <div className="font-mono text-foreground">
                  {away} <ProbOdds p={1 - prediction.p_home_reg - prediction.p_tie_reg} /> · {home} <ProbOdds p={prediction.p_home_reg} />
                </div>
              </div>
              <div>
                <div className="text-muted">Tied after 60:00</div>
                <div className="font-mono text-foreground"><ProbOdds p={prediction.p_tie_reg} /></div>
              </div>
              <div>
                <div className="text-muted">Goes to shootout</div>
                <div className="font-mono text-foreground">{prediction.p_shootout !== null ? <ProbOdds p={prediction.p_shootout} /> : "—"}</div>
              </div>
              <div>
                <div className="text-muted">Expected final score</div>
                <div className="font-mono text-foreground">
                  {away} {prediction.exp_away.toFixed(2)} – {prediction.exp_home.toFixed(2)} {home}
                </div>
              </div>
            </div>
          </Card>

          <Card title={`Model vs ${m?.provider ?? "the book"}`} note="moneyline · puck line · total">
            <NhlMarketComparison rows={marketEdges(prediction, home, away)} provider={m?.provider ?? null} />
            <NhlYourLine
              home={home}
              away={away}
              dists={{ p_home: prediction.p_home, margin_dist: prediction.margin_dist, total_dist: prediction.total_dist }}
              defaults={{ homeSpread: m?.spread_home_line ?? null, total: m?.total_line ?? null }}
            />
          </Card>

          <Card title="Score probabilities" note={`most likely: ${away} ${mostLikelyScore(prediction).away} – ${mostLikelyScore(prediction).home} ${home} (${pct(mostLikelyScore(prediction).p)}, ${fairOdds(mostLikelyScore(prediction).p)})`}>
            <ScoreGrid home={home} away={away} finalGrid={prediction.score_matrix} regGrid={prediction.score_matrix_reg} homeColor={colors.home} awayColor={colors.away} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Total goals" note={`expected ${prediction.exp_total.toFixed(2)} (final score, shootout goal counted)`}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-1.5 text-left font-medium">Line</th>
                      <th className="px-3 py-1.5 text-right font-medium">Over</th>
                      <th className="px-3 py-1.5 text-right font-medium">Under</th>
                      <th className="px-3 py-1.5 text-right font-medium" title="Whole-number lines refund on exactly that many goals">
                        Push
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {TOTAL_LINES.map((line) => {
                      const f = overUnder(prediction.total_dist, line);
                      const live = 1 - f.push;
                      const isMarket = m?.total_line === line;
                      return (
                        <tr key={line} className={`border-b border-border last:border-0 ${isMarket ? "bg-accent/5" : ""}`}>
                          <td className="px-3 py-1.5 font-mono text-foreground">
                            {line % 1 === 0 ? line.toFixed(0) : line.toFixed(1)}
                            {isMarket && <span className="ml-1.5 text-[10px] text-accent">{m?.provider ? "DK line" : "book line"}</span>}
                          </td>
                          <Cell strong>
                            <ProbOdds p={f.over / live} />
                          </Cell>
                          <Cell strong>
                            <ProbOdds p={f.under / live} />
                          </Cell>
                          <Cell>{f.push > 0.001 ? pct(f.push) : "—"}</Cell>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                Final score, so a shootout winner&apos;s extra goal counts (a 3–3 game decided 4–3 is 7 goals). On whole-number lines the over/under are priced
                without the push, since a push is refunded.
              </p>
            </Card>

            <Card title="Puck line" note="each row: the two sides of one line add to 100%">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-1.5 text-left font-medium">
                        <span className="flex items-center gap-2">
                          <NhlTeamLogo team={home} size={18} />
                          {home}
                        </span>
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium">
                        <span className="flex items-center justify-end gap-2">
                          {away}
                          <NhlTeamLogo team={away} size={18} />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {PUCK_LINES.map((line) => {
                      const isBook = m?.spread_home_line === line;
                      const homeP = puckLineCover(prediction.margin_dist, "home", line);
                      const awayP = puckLineCover(prediction.margin_dist, "away", -line);
                      return (
                        <tr key={line} className={`border-b border-border last:border-0 ${isBook ? "bg-accent/5" : ""}`}>
                          <td className="px-3 py-1.5 font-mono text-foreground">
                            <span className={`inline-block w-10 font-semibold ${Math.abs(line) === 1.5 ? "text-foreground" : "text-muted"}`}>{signed(line)}</span>
                            <ProbOdds p={homeP} />
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">
                            <ProbOdds p={awayP} />
                            <span className={`ml-2 inline-block w-10 text-right font-semibold ${Math.abs(line) === 1.5 ? "text-foreground" : "text-muted"}`}>{signed(-line)}</span>
                            {isBook && <span className="ml-1.5 text-[10px] text-accent">DK line</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                A shootout or overtime win is a one-goal margin on the official score, so -1.5 needs a regulation win by two or more (an empty-net goal counts).
              </p>
            </Card>
          </div>

          {prediction.assumptions && (
            <Card title="Goalies" note={prediction.assumptions.goalie_confirmed ? "both starters confirmed" : "starters not both confirmed"}>
              <GoalieLock
                gameId={game.id}
                home={home}
                away={away}
                assumptions={prediction.assumptions}
                canLock={Boolean(prediction.sim_params) && !game.completed && !game.live_status}
              />
              <p className="mt-3 text-[11px] text-muted">
                Starters come from ESPN&apos;s probable-goalie call (it flips from expected to confirmed when a team announces), falling back to who started each
                team&apos;s last 10 games. When ESPN is only &quot;expected&quot;, the model hedges 75/25 with our next-most-likely starter. Ratings are saves
                above expected per 100 attempts, heavily shrunk toward average. Lock in a goalie to re-run this game instantly; locks survive refreshes.
              </p>
            </Card>
          )}
        </>
      )}

      {xg && (
        <Card title="Expected goals (our model)" note="live-net chances, empty-net excluded">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-3 py-1.5 text-left font-medium">Team</th>
                <th className="px-3 py-1.5 text-right font-medium">xG</th>
                <th className="px-3 py-1.5 text-right font-medium">Goals</th>
                <th className="px-3 py-1.5 text-right font-medium">xG even strength</th>
                <th className="px-3 py-1.5 text-right font-medium">xG power play</th>
                <th className="px-3 py-1.5 text-right font-medium">Shots on goal</th>
                <th className="px-3 py-1.5 text-right font-medium">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [away, xg.away_xg, game.away_points, xg.away_xg_ev, xg.away_xg_pp, xg.away_sog, xg.away_corsi],
                  [home, xg.home_xg, game.home_points, xg.home_xg_ev, xg.home_xg_pp, xg.home_sog, xg.home_corsi],
                ] as const
              ).map(([team, x, goals, ev, pp, sog, corsi]) => (
                <tr key={team} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-foreground">{team}</td>
                  <Cell strong>{x?.toFixed(2) ?? "—"}</Cell>
                  <Cell>{goals ?? "—"}</Cell>
                  <Cell>{ev?.toFixed(2) ?? "—"}</Cell>
                  <Cell>{pp?.toFixed(2) ?? "—"}</Cell>
                  <Cell>{sog ?? "—"}</Cell>
                  <Cell>{corsi ?? "—"}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted">
            Shots on goal and attempts are regulation only; xG covers regulation and overtime. Goals include any empty-net or shootout credit, so they can run
            slightly above xG.
          </p>
        </Card>
      )}
    </div>
  );
}
