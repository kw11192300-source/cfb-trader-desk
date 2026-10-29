import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getResults } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const WINDOWS: [string, number][] = [["7 days", 7], ["30 days", 30], ["90 days", 90]];
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
const shade = (n: number, max: number) => (Math.abs(n) < 0.5 ? undefined : { background: `${n > 0 ? "rgba(34,197,94," : "rgba(239,68,68,"}${Math.min(0.35, (Math.abs(n) / max) * 0.35)})` });

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ d?: string; sport?: string }> }) {
  const sp = await searchParams;
  const days = WINDOWS.find(([, v]) => String(v) === sp.d)?.[1] ?? 30;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport : undefined;
  const [{ syndicates, meta }, results] = await Promise.all([getExchange(), getResults(days, sport)]);
  const q = (o: { d?: number; sport?: string | null }) => {
    const p = new URLSearchParams();
    const d = o.d ?? days, s = o.sport === undefined ? sport : o.sport;
    if (d !== 30) p.set("d", String(d));
    if (s) p.set("sport", s);
    return `/syndicates/history${p.toString() ? `?${p}` : ""}`;
  };
  const byDay: Record<string, { games: number; traded: number; syn: Record<string, number>; sport: Record<string, number> }> = {};
  for (const r of results) {
    const d = (byDay[r.day] ??= { games: 0, traded: 0, syn: {}, sport: {} });
    d.games += 1;
    d.traded += r.traded;
    for (const [sid, v] of Object.entries(r.syn)) d.syn[sid] = (d.syn[sid] ?? 0) + v.pnl;
  }
  const dayRows = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0]));
  const totals: Record<string, number> = {}, traded: Record<string, number> = {};
  for (const r of results) for (const [sid, v] of Object.entries(r.syn)) { totals[sid] = (totals[sid] ?? 0) + v.pnl; traded[sid] = (traded[sid] ?? 0) + v.traded; }
  const cols = [...syndicates].sort((a, b) => (totals[b.id] ?? 0) - (totals[a.id] ?? 0));
  const maxCell = Math.max(1, ...dayRows.flatMap(([, d]) => Object.values(d.syn).map(Math.abs)));

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="history" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Results by day</h2>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <div className="flex gap-1">
              {WINDOWS.map(([lab, v]) => <Link key={v} href={q({ d: v })} className={`rounded px-2.5 py-1 ${v === days ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{lab}</Link>)}
            </div>
            <div className="flex gap-1">
              <Link href={q({ sport: null })} className={`rounded px-2.5 py-1 ${!sport ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All sports</Link>
              {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={`rounded px-2.5 py-1 ${sport === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{SPORT[s]}</Link>)}
            </div>
          </div>
        </div>

        {results.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No finished games yet. Results appear here as the games the syndicates traded finish and settle, and stay here permanently.</p>
        ) : (
          <>
            <section className="mb-8">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Day</th>
                      <th className="px-2 py-2 text-right">Games</th>
                      <th className="px-2 py-2 text-right" title="Units of cost posted by both sides of every trade">Traded</th>
                      {cols.map((s) => (
                        <th key={s.id} className="px-2 py-2 text-right font-medium" title={s.name}>
                          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />{s.name.split(" ")[0]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {dayRows.map(([d, v]) => (
                      <tr key={d} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">{new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</td>
                        <td className="px-2 py-1.5 text-right text-muted">{v.games}</td>
                        <td className="px-2 py-1.5 text-right text-muted">{Math.round(v.traded).toLocaleString()}</td>
                        {cols.map((s) => <td key={s.id} className={`px-2 py-1.5 text-right ${tone(v.syn[s.id] ?? 0)}`} style={shade(v.syn[s.id] ?? 0, maxCell)}>{v.syn[s.id] == null ? "" : u(v.syn[s.id])}</td>)}
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-surface font-semibold">
                      <td className="px-3 py-1.5 font-sans text-foreground">Total</td>
                      <td className="px-2 py-1.5 text-right text-muted">{results.length}</td>
                      <td className="px-2 py-1.5 text-right text-muted">{Math.round(results.reduce((a, r) => a + r.traded, 0)).toLocaleString()}</td>
                      {cols.map((s) => <td key={s.id} className={`px-2 py-1.5 text-right ${tone(totals[s.id] ?? 0)}`}>{u(totals[s.id] ?? 0)}</td>)}
                    </tr>
                    <tr className="bg-surface">
                      <td className="px-3 py-1.5 font-sans text-muted" colSpan={3}>ROI on units traded</td>
                      {cols.map((s) => <td key={s.id} className={`px-2 py-1.5 text-right text-[10px] ${tone(totals[s.id] ?? 0)}`}>{traded[s.id] ? `${(((totals[s.id] ?? 0) / traded[s.id]) * 100).toFixed(1)}%` : ""}</td>)}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Profit or loss actually realized on each day&rsquo;s finished games (the day is the US-Eastern date of kickoff), for every trade made on them including positions that were netted off earlier. Every trade has a buyer and a seller, so each row adds up to zero across all syndicates.</p>
            </section>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Finished games</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Kickoff</th><th className="px-3 py-2 text-right">Final</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2">Biggest winner</th><th className="px-3 py-2">Biggest loser</th></tr>
                  </thead>
                  <tbody className="font-mono">
                    {results.slice(0, 80).map((r) => {
                      const es = Object.entries(r.syn).sort((a, b) => b[1].pnl - a[1].pnl);
                      const win = es[0], lose = es[es.length - 1];
                      const nm = (id: string) => syndicates.find((s) => s.id === id)?.name ?? id;
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[r.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(r.id)}`} className="hover:text-accent">{r.away.abbr} @ {r.home.abbr}</Link></td>
                          <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={r.kickoff} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                          <td className="px-3 py-1.5 text-right">{r.away_score}–{r.home_score}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{Math.round(r.contracts).toLocaleString()}</td>
                          <td className="px-3 py-1.5 font-sans">{win ? <><span className="text-foreground">{nm(win[0])}</span> <span className="font-mono text-up">{u(win[1].pnl)}</span></> : ""}</td>
                          <td className="px-3 py-1.5 font-sans">{lose && lose[1].pnl < 0 ? <><span className="text-foreground">{nm(lose[0])}</span> <span className="font-mono text-down">{u(lose[1].pnl)}</span></> : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Click a game for its full result while its trades are still on file (about two weeks); after that the results stay here but the trade-by-trade detail is tidied away.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
