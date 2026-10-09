import GoalieLock from "./GoalieLock";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import ProbOdds from "./ProbOdds";
import ScoreGrid from "./ScoreGrid";
import { devig, fairMoneyline, fairOdds, fmtOdds, mostLikelyScore, overUnder, pct, puckLineCover } from "@/lib/nhlModel";
import type { Game, NhlGameXg, NhlPrediction } from "@/lib/types";

const LADDER = [4.5, 5.5, 6.5, 7.5, 8.5];

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

function WinBar({ home, away, pHome }: { home: string; away: string; pHome: number }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-foreground">
          {away} <span className="font-mono font-semibold"><ProbOdds p={1 - pHome} /></span>
        </span>
        <span className="text-foreground">
          <span className="font-mono font-semibold"><ProbOdds p={pHome} /></span> {home}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-raised">
        <div className="h-full" style={{ width: `${(1 - pHome) * 100}%`, background: "var(--warn)" }} />
        <div className="h-full" style={{ width: `${pHome * 100}%`, background: "var(--accent)" }} />
      </div>
    </div>
  );
}

export default function NhlGameView({ game, prediction, xg }: { game: Game; prediction: NhlPrediction | null; xg: NhlGameXg | null }) {
  const home = game.home_team;
  const away = game.away_team;
  const done = game.completed && game.home_points !== null && game.away_points !== null;
  const m = prediction?.market ?? null;
  const fair = fairMoneyline(m);
  const lines = m?.total_line !== null && m?.total_line !== undefined && !LADDER.includes(m.total_line) ? [...LADDER, m.total_line].sort((a, b) => a - b) : LADDER;

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
            <WinBar home={home} away={away} pHome={prediction.p_home} />
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
            {fair && (
              <div className="mt-4 rounded-md bg-surface-raised px-3 py-2 text-xs text-muted">
                Market ({m?.provider ?? "book"}): posted {away} {fmtOdds(m?.ml_away ?? null)} / {home} {fmtOdds(m?.ml_home ?? null)}; no-vig {away}{" "}
                <ProbOdds p={fair.away} /> · {home} <ProbOdds p={fair.home} /> — model is{" "}
                <span className="font-mono text-foreground">
                  {prediction.p_home - fair.home >= 0 ? "+" : ""}
                  {((prediction.p_home - fair.home) * 100).toFixed(1)} pts
                </span>{" "}
                on {home}.
              </div>
            )}
          </Card>

          <Card title="Score probabilities" note={`most likely: ${away} ${mostLikelyScore(prediction).away} – ${mostLikelyScore(prediction).home} ${home} (${pct(mostLikelyScore(prediction).p)}, ${fairOdds(mostLikelyScore(prediction).p)})`}>
            <ScoreGrid home={home} away={away} finalGrid={prediction.score_matrix} regGrid={prediction.score_matrix_reg} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Total goals" note={`expected ${prediction.exp_total.toFixed(2)} (final score)`}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-1.5 text-left font-medium">Line</th>
                      <th className="px-3 py-1.5 text-right font-medium" title="Official final score - the shootout winner is credited one goal. How most US books settle full-game totals.">
                        Over / Under (final)
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium" title="Through overtime but WITHOUT the shootout goal">
                        Over (thru OT)
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium" title="60-minute market">
                        Over (60:00)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const f = overUnder(prediction.total_dist, line);
                      const o = prediction.extras ? overUnder(prediction.extras.ot_total_dist, line) : null;
                      const r = prediction.extras ? overUnder(prediction.extras.reg_total_dist, line) : null;
                      const isMarket = m?.total_line === line;
                      return (
                        <tr key={line} className={`border-b border-border last:border-0 ${isMarket ? "bg-accent/5" : ""}`}>
                          <td className="px-3 py-1.5 font-mono text-foreground">
                            {line.toFixed(1)}
                            {isMarket && <span className="ml-1.5 text-[10px] text-accent">book</span>}
                          </td>
                          <Cell strong>
                            <ProbOdds p={f.over} /> / <ProbOdds p={f.under} />
                            {f.push > 0.001 && <span className="text-muted"> · push {pct(f.push)}</span>}
                          </Cell>
                          <Cell>{o ? <ProbOdds p={o.over} stacked /> : "—"}</Cell>
                          <Cell>{r ? <ProbOdds p={r.over} stacked /> : "—"}</Cell>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                Settlement differs by market: full-game totals at most US books count the shootout goal (a 3–3 game decided 4–3 is 7 goals); some
                markets are 60-minute or exclude the shootout. Check which one you&apos;re betting.
              </p>
            </Card>

            <Card title="Puck line" note="probability each side covers">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-1.5 text-left font-medium">Side</th>
                      <th className="px-3 py-1.5 text-right font-medium">-2.5</th>
                      <th className="px-3 py-1.5 text-right font-medium">-1.5</th>
                      <th className="px-3 py-1.5 text-right font-medium">+1.5</th>
                      <th className="px-3 py-1.5 text-right font-medium">+2.5</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        [home, "home"],
                        [away, "away"],
                      ] as const
                    ).map(([name, side]) => (
                      <tr key={side} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 text-foreground">{name}</td>
                        {[-2.5, -1.5, 1.5, 2.5].map((line) => (
                          <Cell key={line} strong={Math.abs(line) === 1.5}>
                            <ProbOdds p={puckLineCover(prediction.margin_dist, side, line)} stacked />
                          </Cell>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                A shootout or overtime win is a one-goal margin on the official score, so -1.5 needs a regulation win by two or more (an empty-net goal
                counts).
              </p>
              {m && m.spread_home_line !== null && m.spread_home_odds !== null && m.spread_away_odds !== null && (
                <div className="mt-3 rounded-md bg-surface-raised px-3 py-2 text-xs text-muted">
                  {m.provider ?? "Book"}: {home} {m.spread_home_line > 0 ? "+" : ""}
                  {m.spread_home_line} ({fmtOdds(m.spread_home_odds)}) / {away} {m.spread_home_line > 0 ? "" : "+"}
                  {-m.spread_home_line} ({fmtOdds(m.spread_away_odds)}) — no-vig {home} cover <ProbOdds p={devig(m.spread_home_odds, m.spread_away_odds)} />, model{" "}
                  <span className="font-mono text-foreground">
                    <ProbOdds p={puckLineCover(prediction.margin_dist, "home", m.spread_home_line)} />
                  </span>
                </div>
              )}
            </Card>
          </div>

          {m && m.total_line !== null && m.over_odds !== null && m.under_odds !== null && (
            <Card title={`Totals vs ${m.provider ?? "the book"}`}>
              <div className="text-xs text-muted">
                Line {m.total_line.toFixed(1)} (over {fmtOdds(m.over_odds)} / under {fmtOdds(m.under_odds)}); no-vig over <ProbOdds p={devig(m.over_odds, m.under_odds)} />. Model (final score):
                over{" "}
                <span className="font-mono text-foreground">
                  <ProbOdds p={overUnder(prediction.total_dist, m.total_line).over / (1 - overUnder(prediction.total_dist, m.total_line).push)} />
                </span>{" "}
                excluding pushes.
              </div>
            </Card>
          )}

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
