import Link from "next/link";

import { sideText } from "@/lib/positions";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getDigests, getExchange, label, pct } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

export default async function DigestPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const sp = await searchParams;
  const [digests, { meta }] = await Promise.all([getDigests(21), getExchange()]);
  const d = digests.find((x) => x.day === sp.day) ?? digests[0];
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="digest" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
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
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No games the syndicates traded finished that day.</p>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["Games settled", String(d.games)], ["Contracts traded", d.contracts.toLocaleString()], ["Units traded", d.traded.toLocaleString()], ["Syndicates in profit", `${d.syndicates.filter((s) => s.pnl > 0).length} of ${d.syndicates.length}`]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
              ))}
            </div>

            <div className="mb-6 grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">Syndicates, by profit</h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Syndicate</th><th className="px-3 py-2 text-right">Realized</th><th className="px-3 py-2 text-right">Traded</th><th className="px-3 py-2 text-right" title="Average closing-line value on that day's trades">CLV</th></tr></thead>
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
