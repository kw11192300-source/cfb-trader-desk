import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { sideText } from "@/lib/positions";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getDigests, getExchange, getGamesWindow, getPicks, getResults, label, pct, type ExMember, type ExSyndicate } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

const etDay = (d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** The live version of the daily digest: today's finished games so far (US Eastern day), what is still to play, and the open paper picks. The morning digest replaces it once the day is final. */
async function Nightly({ syndicates, members }: { syndicates: ExSyndicate[]; members: ExMember[] }) {
  const today = etDay(new Date());
  const now = Date.now();
  const [results, games, picks] = await Promise.all([getResults(2, undefined, true), getGamesWindow(new Date(now - 14 * 3600000).toISOString(), new Date(now + 30 * 3600000).toISOString()), getPicks()]);
  const done = results.filter((r) => r.day === today);
  const firms: Record<string, { pnl: number; traded: number; clvS: number; clvN: number }> = {};
  const traders: Record<string, number> = {};
  for (const r of done) {
    for (const [sid, v] of Object.entries(r.syn)) {
      const f = (firms[sid] ??= { pnl: 0, traded: 0, clvS: 0, clvN: 0 });
      f.pnl += v.pnl; f.traded += v.traded; f.clvS += v.clv_sum; f.clvN += v.clv_n;
    }
    for (const [mid, v] of Object.entries(r.traders ?? {})) traders[mid] = (traders[mid] ?? 0) + v.pnl;
  }
  const syn = Object.fromEntries(syndicates.map((s) => [s.id, s]));
  const mem = Object.fromEntries(members.map((m) => [m.id, m]));
  const rows = Object.entries(firms).sort((a, b) => b[1].pnl - a[1].pnl);
  const tr = Object.entries(traders).sort((a, b) => b[1] - a[1]).filter(([id]) => mem[id]);
  const still = games.filter((g) => etDay(g.start_utc) === today && !g.completed).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  const live = still.filter((g) => g.state === "in").length;
  const contracts = done.reduce((a, r) => a + r.contracts, 0);
  const upcomingPicks = picks.open.filter((p) => etDay(p.start) === today || new Date(p.start).getTime() - now < 30 * 3600000).length;
  return (
    <section className="mb-8 rounded-lg border border-accent/40 bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">Tonight so far <span className="text-[11px] font-normal text-muted">({fmtDay(today)}, US Eastern)</span></h2>
        <span className="text-[11px] text-muted">Live. The morning digest below replaces it once the day is final.</span>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Games finished", String(done.length)], ["Still to play today", `${still.length}${live ? ` (${live} live)` : ""}`], ["Contracts traded (finished)", Math.round(contracts).toLocaleString()], ["Firms in profit", rows.length ? `${rows.filter(([, v]) => v.pnl > 0).length} of ${rows.length}` : "–"]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-background px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
        ))}
      </div>
      {done.length === 0 ? (
        <p className="mb-4 rounded-lg border border-border bg-background px-3 py-4 text-center text-xs text-muted">No games have finished yet today.</p>
      ) : (
        <div className="mb-4 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold text-foreground">Firms, by profit so far</p>
            <table className="w-full text-xs">
              <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Firm</th><th className="py-1 text-right font-medium">Realized</th><th className="py-1 text-right font-medium">Traded</th><th className="py-1 text-right font-medium">CLV</th></tr></thead>
              <tbody className="font-mono">
                {(rows.length <= 10 ? rows : [...rows.slice(0, 5), ...rows.slice(-5)]).map(([sid, v]) => (
                  <tr key={sid} className="border-t border-border">
                    <td className="py-1 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: syn[sid]?.color }} />{syn[sid]?.name ?? sid}</td>
                    <td className={`py-1 text-right ${tone(v.pnl)}`}>{u(v.pnl)}</td>
                    <td className="py-1 text-right text-muted">{Math.round(v.traded).toLocaleString()}</td>
                    <td className={`py-1 text-right ${v.clvN ? tone(v.clvS / v.clvN) : "text-muted"}`}>{v.clvN ? `${v.clvS / v.clvN >= 0 ? "+" : ""}${((v.clvS / v.clvN) * 100).toFixed(1)}¢` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-foreground">Traders so far</p>
            <div className="grid grid-cols-2 gap-3 text-xs">
              {([["Best", tr.slice(0, 4)], ["Worst", tr.slice(-4).reverse()]] as const).map(([name, list]) => (
                <ul key={name} className="rounded-lg border border-border bg-background p-2">
                  <li className="mb-1 text-[10px] uppercase tracking-wide text-muted">{name}</li>
                  {list.map(([id, pnl]) => <li key={id} className="flex justify-between gap-2 py-0.5"><Link href={`/syndicates/traders/${id}`} className="truncate text-foreground hover:text-accent">{mem[id].name} <span className="text-muted">· {syn[mem[id].syndicate_id]?.name}</span></Link><span className={`font-mono ${tone(pnl)}`}>{u(pnl)}</span></li>)}
                </ul>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Still to play today</p>
          {still.length === 0 ? <p className="text-xs text-muted">Nothing left on today&rsquo;s slate.</p> : (
            <ul className="space-y-1 text-xs">
              {still.slice(0, 8).map((g) => (
                <li key={g.id} className="flex justify-between gap-2 border-t border-border pt-1">
                  <Link href={`/syndicates/games/${encodeURIComponent(g.id)}`} className="text-foreground hover:text-accent"><span className="mr-2 text-[10px] text-muted">{SPORT[g.sport]}</span>{g.away.abbr} @ {g.home.abbr}</Link>
                  <span className="text-muted">{g.state === "in" ? <span className="text-down">live</span> : <LocalDateTime iso={g.start_utc} options={{ hour: "numeric", minute: "2-digit" }} />}{g.contracts > 0 ? ` · ${Math.round(g.contracts).toLocaleString()} traded` : ""}</span>
                </li>
              ))}
              {still.length > 8 && <li className="pt-1 text-[11px] text-muted">and {still.length - 8} more</li>}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Paper picks</p>
          <p className="text-xs text-muted"><Link href="/picks" className="text-accent hover:underline">{picks.open.length} open</Link>{upcomingPicks ? `, ${upcomingPicks} for games starting in the next day` : ""}. {picks.done.length} graded so far.</p>
        </div>
      </div>
    </section>
  );
}

export default async function DigestPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const sp = await searchParams;
  const [digests, { meta, syndicates, members }] = await Promise.all([getDigests(21), getExchange()]);
  const d = digests.find((x) => x.day === sp.day) ?? digests[0];
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="digest" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        {!sp.day && <Nightly syndicates={syndicates} members={members} />}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{d ? `Digest for ${fmtDay(d.day)}` : "Daily digest"} <span className="text-[11px] font-normal text-muted">(US Eastern day, by when the game started)</span></h2>
          <div className="flex flex-wrap gap-1 text-[11px]">
            {digests.slice(0, 10).map((x) => (
              <Link key={x.day} href={`/syndicates/digest?day=${x.day}`} className={`rounded px-2 py-1 ${d?.day === x.day ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
                {new Date(`${x.day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </Link>
            ))}
          </div>
        </div>

        {!d ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            The first digest is written the morning after games finish (after 6 am Eastern) and covers the previous day. Come back tomorrow.
          </p>
        ) : d.games === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No games the trading firms traded finished that day.</p>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["Games settled", String(d.games)], ["Contracts traded", d.contracts.toLocaleString()], ["Units traded", d.traded.toLocaleString()], ["Trading firms in profit", `${d.syndicates.filter((s) => s.pnl > 0).length} of ${d.syndicates.length}`]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
              ))}
            </div>

            <div className="mb-6 grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">Trading firms, by profit</h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Firm</th><th className="px-3 py-2 text-right">Realized</th><th className="px-3 py-2 text-right">Traded</th><th className="px-3 py-2 text-right" title="Average closing-line value on that day's trades">CLV</th></tr></thead>
                    <tbody className="font-mono">
                      {d.syndicates.map((s) => (
                        <tr key={s.id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/${s.id}`} className="hover:text-accent">{s.name}</Link></td>
                          <td className={`px-3 py-1.5 text-right ${tone(s.pnl)}`}>{u(s.pnl)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.traded.toLocaleString()}</td>
                          <td className={`px-3 py-1.5 text-right ${s.clv == null ? "text-muted" : tone(s.clv)}`}>{s.clv == null ? "–" : `${s.clv >= 0 ? "+" : ""}${(s.clv * 100).toFixed(1)}¢`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="space-y-6">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">Best and worst traders</h3>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {[["Best", d.best_traders], ["Worst", d.worst_traders]].map(([t, rows]) => (
                      <ul key={t as string} className="rounded-lg border border-border bg-surface p-2">
                        <li className="mb-1 text-[10px] uppercase tracking-wide text-muted">{t as string}</li>
                        {(rows as typeof d.best_traders).map((r) => (
                          <li key={r.id} className="flex justify-between gap-2 py-0.5"><Link href={`/syndicates/traders/${r.id}`} className="truncate text-foreground hover:text-accent">{r.name} <span className="text-muted">· {r.syn}</span></Link><span className={`font-mono ${tone(r.pnl)}`}>{u(r.pnl)}</span></li>
                        ))}
                      </ul>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">Sharpest hits</h3>
                  <ul className="space-y-1 rounded-lg border border-border bg-surface p-2 text-xs">
                    {d.sharp.length === 0 && <li className="text-muted">None recorded.</li>}
                    {d.sharp.map((x, i) => {
                      // in terms of the side actually played: selling "yes" is playing the other team, the under, or the away moneyline, at the mirror price
                      const [away, home] = x.teams.split(" @ ");
                      const buy = x.side !== "sell";
                      const played = sideText({ home: { abbr: home }, away: { abbr: away } } as never, x.kind, x.line, buy ? 1 : -1);
                      const paid = buy ? x.price : 1 - x.price;
                      const closed = x.close == null ? null : buy ? x.close : 1 - x.close;
                      return (
                        <li key={i} className="flex justify-between gap-2">
                          <span className="text-foreground">{x.who} <span className="text-muted">· {x.teams} · played </span>{played}<span className="text-muted"> at {pct(paid)}{closed != null ? `, closed ${pct(closed)}` : ""} × {x.qty.toFixed(0)}</span></span>
                          <span className="shrink-0 font-mono text-up">+{(x.clv * 100).toFixed(1)}¢</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-1 text-[11px] text-muted">The hits that beat the closing price by the most, weighted by size.</p>
                </div>
              </section>
            </div>

            <div className="mb-6 grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">Busiest games</h3>
                <ul className="space-y-1 rounded-lg border border-border bg-surface p-2 text-xs">
                  {d.games_top.map((g) => (
                    <li key={g.id} className="flex justify-between gap-2">
                      <Link href={`/syndicates/games/${encodeURIComponent(g.id)}`} className="text-foreground hover:text-accent"><span className="mr-2 text-[10px] text-muted">{SPORT[g.sport]}</span>{g.teams} <span className="text-muted">({g.score})</span></Link>
                      <span className="text-muted">{g.contracts.toLocaleString()} contracts{g.winner ? <> · top: <span className="text-foreground">{g.winner}</span> <span className="font-mono text-up">{u(g.win_pnl)}</span></> : null}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">Labs and learning</h3>
                <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-xs text-muted">
                  {d.labs.length === 0 ? <p>No lab published a new model that day.</p> : d.labs.map((l) => <p key={l.id}><span className="text-foreground">{l.name}</span> published v{l.version}: {l.notes}</p>)}
                  <p className="pt-1 text-[10px] uppercase tracking-wide">Highest model weights now</p>
                  {d.weights.map((w, i) => <p key={i}><span className="text-foreground">{w.name}</span> in {SPORT[w.sport]}: <span className="font-mono">{Math.round(w.w * 100)}%</span></p>)}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
