import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import LocalDateTime from "@/components/LocalDateTime";
import NbaBetButtons from "@/components/NbaBetButtons";
import NbaModelBuild from "@/components/NbaModelBuild";
import NbaModelButton from "@/components/NbaModelButton";
import NbaModelVsOdds from "@/components/NbaModelVsOdds";
import NbaPlayerTable from "@/components/NbaPlayerTable";
import NbaPropsExplorer from "@/components/NbaPropsExplorer";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets, getNbaGame, getNbaInjuries, getNbaPlayers, getNbaProjections, getNbaSnapshots, type NbaInjury } from "@/lib/data";
import { devig, fairOdds, impliedProb } from "@/lib/nbaProj";
import { nbaLogo, nbaShort } from "@/lib/nbaTeams";
import { etDay } from "@/lib/nhlTeamGames";

export const dynamic = "force-dynamic";

const sp = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : n > 0 ? `+${n.toFixed(d)}` : n.toFixed(d));
const sp0 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);
const nameKey = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

function Logo({ team, size = 44 }: { team: string; size?: number }) {
  const src = nbaLogo(team);
  return src ? <Image src={src} alt="" width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} unoptimized /> : <span className="inline-block shrink-0 rounded-full bg-surface-raised" style={{ width: size, height: size }} />;
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" | "warn" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`font-mono text-base font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function InjuryBlock({ team, rows, ratings }: { team: string; rows: NbaInjury[]; ratings: Record<string, number> }) {
  const mine = rows.filter((r) => r.team === team && r.player && !/g league|two-way/i.test(`${r.reason_cat ?? ""} ${r.reason_detail ?? ""}`));
  if (rows.some((r) => r.team === team && r.player === "") && mine.length === 0) return <div className="text-xs text-muted">{nbaShort(team)}: report not submitted yet</div>;
  if (mine.length === 0) return null;
  const order = ["Out", "Doubtful", "Questionable", "Probable", "Available"];
  return (
    <div className="text-xs leading-relaxed">
      <span className="font-medium text-foreground">{nbaShort(team)}</span>{" "}
      {mine
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (ratings[nameKey(b.player)] ?? -99) - (ratings[nameKey(a.player)] ?? -99))
        .map((r, i) => {
          const net = ratings[nameKey(r.player)];
          const tone = r.status === "Out" || r.status === "Doubtful" ? "text-down" : r.status === "Questionable" ? "text-warn" : "text-muted";
          return (
            <span key={r.player}>
              {i > 0 ? " · " : ""}
              <span className={tone}>
                {r.player} <span className="text-[10px]">{r.status === "Available" ? "AVAIL" : r.status.slice(0, 1)}</span>
              </span>
              {net !== undefined && <span className="font-mono text-muted"> ({net > 0 ? "+" : ""}{net.toFixed(1)})</span>}
              {r.reason_detail ? <span className="text-muted"> {r.reason_detail}</span> : null}
            </span>
          );
        })}
    </div>
  );
}

export default async function NbaGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gameId = Number(id);
  if (!Number.isFinite(gameId)) notFound();
  const game = await getNbaGame(gameId);
  if (!game) notFound();
  const day = etDay(game.start_date);
  const [snapMap, injuries, rated, proj, allBets] = await Promise.all([getNbaSnapshots([game.id]), getNbaInjuries(day), getNbaPlayers(2026, { teams: [game.home_team, game.away_team] }), getNbaProjections([game.id]), getBets({ sport: "nba", gameId: game.id, withLines: false })]);
  const snaps = snapMap.get(game.id) ?? [];
  const cur = snaps.length ? snaps[snaps.length - 1] : null;
  const first = snaps.length ? snaps[0] : null;
  const gp = proj.games.get(game.id);
  const players = proj.players.get(game.id) ?? [];
  const model = gp?.detail?.model;
  const ratings: Record<string, number> = {};
  for (const p of rated) if (p.net !== null) ratings[nameKey(p.name)] = p.net;
  const mine = allBets.filter((b) => b.bet.sport === "nba" && b.bet.game_id === game.id);

  const homeShort = nbaShort(game.home_team);
  const awayShort = nbaShort(game.away_team);
  const live = game.live_status;
  const hp = game.completed ? game.home_points : (live?.home_points ?? null);
  const ap = game.completed ? game.away_points : (live?.away_points ?? null);
  const started = game.completed || live !== null;
  const when = <LocalDateTime iso={game.start_date} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />;

  const homeLine = cur?.spread_home_line ?? null;
  const total = cur?.total_line ?? null;
  const mktP = devig(cur?.ml_home, cur?.ml_away);
  const modelLine = model ? -model.margin : null; // the home team's own number the model would post
  const nm = gp?.news_move ?? null;
  const gap = gp?.gap ?? null;
  const stale = nm !== null && gap !== null && Math.abs(gap) >= 1 && Math.abs(nm) >= 0.75;
  const leanHome = (gap ?? 0) > 0;
  const contrib = gp?.detail?.contrib;
  const updated = gp ? <LocalDateTime iso={gp.computed_at} options={{ hour: "numeric", minute: "2-digit", timeZoneName: "short" }} /> : null;
  const lastYear: Record<string, { ppg: number; mpg: number }> = {};
  for (const r of rated) {
    const mpg = typeof r.stats.mpg === "number" ? r.stats.mpg : null;
    const p36 = typeof r.stats.pts36 === "number" ? r.stats.pts36 : null;
    if (mpg !== null && p36 !== null) lastYear[nameKey(r.name)] = { ppg: (p36 * mpg) / 36, mpg };
  }
  const homeP = players.filter((p) => p.side === "home");
  const awayP = players.filter((p) => p.side === "away");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={`${game.away_team} @ ${game.home_team}`} sport="nba" />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 px-6 py-6">
        <Link href="/nba" className="text-xs text-muted hover:text-foreground">
          ← Board
        </Link>
        {!game.completed && <NbaModelButton updatedAt={gp?.computed_at ?? null} />}

        {/* header */}
        <div className="rounded-lg border border-border bg-surface px-5 py-4">
          <div className="mb-3 flex items-center justify-between text-xs text-muted">
            <span className={live ? "font-medium text-down" : ""}>{game.completed ? "Final" : live ? `LIVE${live.detail ? ` · ${live.detail}` : ""}` : when}</span>
            {game.venue && <span>{game.venue}</span>}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-12">
            {([[game.away_team, ap, "away"], [game.home_team, hp, "home"]] as const).map(([team, pts, s]) => (
              <div key={s} className="flex items-center gap-3">
                <Logo team={team} />
                <div>
                  <div className="text-lg font-semibold text-foreground">{team}</div>
                  <div className="text-[11px] text-muted">{s === "home" ? "Home" : "Away"}</div>
                </div>
                {started && <span className="ml-2 font-mono text-3xl font-semibold text-foreground">{pts ?? "—"}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* market vs model */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="rounded-lg border border-border bg-surface px-5 py-4 lg:col-span-3">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-foreground">Market vs player-up model</h2>
              {updated && <span className="text-[11px] text-muted">model updated {updated}</span>}
            </div>
            {cur ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-muted">
                      <th className="py-1 text-left font-medium" />
                      <th className="py-1 text-right font-medium">Market</th>
                      <th className="py-1 text-right font-medium">Opened</th>
                      <th className="py-1 text-right font-medium">Model</th>
                      <th className="py-1 text-right font-medium">Model − market</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    <tr className="border-t border-border/50">
                      <td className="py-2 font-sans text-foreground">Spread ({homeShort})</td>
                      <td className="py-2 text-right text-foreground">
                        {sp(homeLine)}
                        {cur.spread_home_odds != null && <div className="text-[10px] text-muted">{sp0(cur.spread_home_odds)} · {Math.round(impliedProb(cur.spread_home_odds) * 100)}%</div>}
                      </td>
                      <td className="py-2 text-right text-muted">{first ? sp(first.spread_home_line) : "—"}</td>
                      <td className="py-2 text-right text-foreground">{modelLine !== null ? sp(Math.round(modelLine * 2) / 2) : "—"}</td>
                      <td className="py-2 text-right text-muted">{modelLine !== null && homeLine !== null ? `${sp(modelLine - homeLine)} ${modelLine - homeLine < 0 ? homeShort : awayShort}` : "—"}</td>
                    </tr>
                    <tr className="border-t border-border/50">
                      <td className="py-2 font-sans text-foreground">Total</td>
                      <td className="py-2 text-right text-foreground">
                        {total ?? "—"}
                        {cur.over_odds != null && <div className="text-[10px] text-muted">o {sp0(cur.over_odds)} · {Math.round(impliedProb(cur.over_odds) * 100)}%</div>}
                      </td>
                      <td className="py-2 text-right text-muted">{first?.total_line ?? "—"}</td>
                      <td className="py-2 text-right text-foreground">{model ? model.total.toFixed(1) : "—"}</td>
                      <td className="py-2 text-right text-muted">{model && total !== null ? `${sp(model.total - total)} ${model.total - total > 0 ? "over" : "under"}` : "—"}</td>
                    </tr>
                    <tr className="border-t border-border/50">
                      <td className="py-2 font-sans text-foreground">Moneyline</td>
                      <td className="py-2 text-right text-foreground">
                        {sp0(cur.ml_away)} / {sp0(cur.ml_home)}
                        {mktP !== null && <div className="text-[10px] text-muted">{Math.round((1 - mktP) * 100)}% / {Math.round(mktP * 100)}%</div>}
                      </td>
                      <td className="py-2 text-right text-muted">{first ? `${sp0(first.ml_away)} / ${sp0(first.ml_home)}` : "—"}</td>
                      <td className="py-2 text-right text-foreground">
                        {model ? `${sp0(model.ml_away)} / ${sp0(model.ml_home)}` : "—"}
                        {model && <div className="text-[10px] text-muted">{Math.round((1 - model.p_home) * 100)}% / {Math.round(model.p_home * 100)}%</div>}
                      </td>
                      <td className="py-2 text-right text-muted">{model && mktP !== null ? `${sp((model.p_home - mktP) * 100, 1)} pts ${homeShort}` : "—"}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="mt-1 text-[10px] text-muted">
                  Moneyline shows {awayShort} / {homeShort}. Model prices are fair (no vig).
                  {model && <> {homeShort} win chance: model {Math.round(model.p_home * 100)}% ({fairOdds(model.p_home)}){mktP !== null ? `, market ${Math.round(mktP * 100)}% (${fairOdds(mktP)})` : ""}.</>}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted">No line posted yet.</div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              The model builds each team from its players: lineup ratings (offence and defence) weighted by projected minutes, averaged over who is in or out on the injury report, with pace and home court on top.
              Tested over three seasons, on its own it is about a point a game less accurate than the market, and its edge over the market&apos;s opening number was almost all injury news the line had not yet absorbed - so
              read gaps as &ldquo;the line may be behind the news&rdquo;, not as a verdict.{model?.level_shift !== undefined && <> The total&apos;s level is matched to today&apos;s posted totals (shift {sp(model.level_shift)}); only game-to-game differences are the model&apos;s.</>}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-surface px-5 py-4 lg:col-span-2">
            <h2 className="text-sm font-semibold text-foreground">Injury news</h2>
            {gp && !(gp.pending_home && gp.pending_away) ? (
              <div className="grid grid-cols-2 gap-3">
                <Cell
                  label="Fresh news worth"
                  value={nm === null || Math.abs(nm) < 0.3 ? "none" : `${Math.abs(nm).toFixed(1)} pts`}
                  sub={nm === null || Math.abs(nm) < 0.3 ? "nothing new to price" : `toward ${nm > 0 ? homeShort : awayShort}`}
                />
                <Cell
                  label="Line has moved"
                  value={gp.moved === null ? "—" : `${Math.abs(gp.moved).toFixed(1)}`}
                  sub={gp.moved === null ? "no line yet" : gp.moved === 0 ? "since first seen" : `toward ${gp.moved > 0 ? homeShort : awayShort} since first seen`}
                />
              </div>
            ) : (
              <div className="text-xs text-muted">{gp ? "Injury reports not in yet - projections assume full rosters." : "Projections appear once the live job has run for this game."}</div>
            )}
            {stale && (
              <div className="rounded border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
                Line may be stale: the news favours {leanHome ? homeShort : awayShort} by about {Math.abs(gap ?? 0).toFixed(1)} more than the line has moved
                {homeLine !== null && <> - lean {leanHome ? `${homeShort} ${sp(homeLine)}` : `${awayShort} ${sp(-homeLine)}`}</>}. <span className="text-muted">Unproven as a bet; the closing line is the test.</span>
              </div>
            )}
            {contrib && (contrib.home.length > 0 || contrib.away.length > 0) && (
              <ul className="space-y-0.5 text-xs text-muted">
                {[...contrib.away.map((c) => ({ ...c, t: awayShort })), ...contrib.home.map((c) => ({ ...c, t: homeShort }))].slice(0, 6).map((c) => (
                  <li key={`${c.t}${c.player_id}`}>
                    <span className="text-foreground">{c.name}</span> ({c.t}) {Math.round(c.p_play * 100)}% to play · {c.effect > 0 ? "+" : ""}
                    {c.effect.toFixed(1)} for his team
                  </li>
                ))}
              </ul>
            )}
            {!game.completed && (
              <div className="space-y-1 border-t border-border/60 pt-3">
                <InjuryBlock team={game.away_team} rows={injuries} ratings={ratings} />
                <InjuryBlock team={game.home_team} rows={injuries} ratings={ratings} />
                <div className="text-[10px] text-muted">Numbers in brackets are lineup rating (net points per 100 possessions the player adds).</div>
              </div>
            )}
          </div>
        </div>

        {model && <NbaModelVsOdds away={game.away_team} home={game.home_team} model={model} cur={cur} />}
        {model && players.length > 0 && <NbaModelBuild away={game.away_team} home={game.home_team} model={model} players={players} rated={rated} />}

        {/* bets */}
        {!game.completed && (
          <div className="rounded-lg border border-border bg-surface px-5 py-3">
            <div className="mb-2 text-xs font-medium text-foreground">Log a bet on this game</div>
            <NbaBetButtons game={game} cur={cur} />
            {mine.length > 0 && (
              <ul className="mt-3 border-t border-border/60 pt-2 text-xs">
                {mine.map(({ bet, status, profit }) => (
                  <li key={bet.id} className="flex items-center justify-between gap-3 py-0.5">
                    <span className="text-foreground">
                      {bet.market === "prop" ? `${bet.player} ${bet.side} ${bet.line} ${bet.prop_type ?? ""}` : bet.market === "moneyline" ? `${bet.side} ML` : bet.market === "total" ? `${bet.side === "over" ? "Over" : "Under"} ${bet.line}` : `${bet.side} ${bet.line}`}{" "}
                      <span className="text-muted">
                        {bet.odds > 0 ? `+${bet.odds}` : bet.odds} · {bet.stake}u
                      </span>
                    </span>
                    <span className={`font-mono ${status === "win" ? "text-up" : status === "loss" ? "text-down" : "text-accent"}`}>{status === "pending" ? "PENDING" : `${status.toUpperCase()} ${profit !== null ? `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}` : ""}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* player projections */}
        {players.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <NbaPlayerTable team={game.away_team} players={awayP} lastYear={lastYear} />
              <NbaPlayerTable team={game.home_team} players={homeP} lastYear={lastYear} />
            </div>
            <p className="text-[11px] text-muted">
              These are expected values for the game - the chance he plays and his place in the rotation are built in - so each column adds up to the team: 240 minutes and the points of the game projection above. A name with a percentage is
              uncertain on the injury report (hover for his line if he plays). The small +/− beside minutes is the change from his usual minutes. Players marked &ldquo;new&rdquo; have no NBA history, so their numbers are generic.
            </p>
            <NbaPropsExplorer players={players} awayTeam={game.away_team} homeTeam={game.home_team} />
          </>
        ) : (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">
            Player projections aren&apos;t ready for this game yet. They are built when the injury report changes (and at least every 90 minutes on game days).
          </div>
        )}

        {/* line history */}
        {snaps.length > 0 && (
          <div className="rounded-lg border border-border bg-surface px-5 py-4">
            <h2 className="mb-2 text-sm font-semibold text-foreground">Line history</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted">
                    <th className="py-1 text-left font-medium">Seen</th>
                    <th className="py-1 text-right font-medium">Spread ({homeShort})</th>
                    <th className="py-1 text-right font-medium">Total</th>
                    <th className="py-1 text-right font-medium">ML {awayShort}</th>
                    <th className="py-1 text-right font-medium">ML {homeShort}</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[...snaps].reverse().slice(0, 14).map((s, i, arr) => (
                    <tr key={s.captured_at} className="border-t border-border/50">
                      <td className="py-1 font-sans text-muted">
                        <LocalDateTime iso={s.captured_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                        {i === 0 && <span className="ml-1 text-accent">current</span>}
                        {i === arr.length - 1 && snaps.length <= 14 && <span className="ml-1 text-muted">first seen</span>}
                      </td>
                      <td className="py-1 text-right text-foreground">{sp(s.spread_home_line)}</td>
                      <td className="py-1 text-right text-foreground">{s.total_line ?? "—"}</td>
                      <td className="py-1 text-right text-foreground">{sp0(s.ml_away)}</td>
                      <td className="py-1 text-right text-foreground">{sp0(s.ml_home)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {model && <div className="mt-2 text-[10px] text-muted">Model fair line: {homeShort} {sp(modelLine !== null ? Math.round(modelLine * 2) / 2 : null)}, total {model.total.toFixed(1)}, {homeShort} ML {fairOdds(model.p_home)}.</div>}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
