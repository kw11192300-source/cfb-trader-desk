import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { fairOf, getAllOpenTrades, getExchange, getGamesFull, getResults, openLots } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");

export default async function SportsPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const [{ syndicates, members, meta }, results, open] = await Promise.all([getExchange(), getResults(365, sport ?? undefined), getAllOpenTrades()]);
  const games = await getGamesFull([...new Set(open.map((t) => t.game_id))]);
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));

  const real: Record<string, { pnl: number; traded: number; clvS: number; clvN: number; games: number }> = {};
  for (const r of results) for (const [sid, v] of Object.entries(r.syn)) {
    const a = (real[sid] ??= { pnl: 0, traded: 0, clvS: 0, clvN: 0, games: 0 });
    a.pnl += v.pnl; a.traded += v.traded; a.clvS += v.clv_sum; a.clvN += v.clv_n; a.games += 1;
  }
  const lots = openLots(open, (m) => synOf[m] ?? null).filter((l) => games[l.gid] && (!sport || games[l.gid].sport === sport));
  const openBy: Record<string, { pnl: number; n: number; games: Set<string> }> = {};
  for (const l of lots) {
    const f = fairOf(games[l.gid], l.kind, l.line);
    const a = (openBy[l.owner] ??= { pnl: 0, n: 0, games: new Set() });
    a.n += 1; a.games.add(l.gid);
    if (f != null) a.pnl += l.qty > 0 ? l.qty * (f - l.price) : -l.qty * (l.price - f);
  }
  const rows = syndicates.map((s) => {
    const r = real[s.id], o = openBy[s.id];
    const clv = r && r.clvN ? r.clvS / r.clvN : null;
    return { s, realized: r?.pnl ?? 0, traded: r?.traded ?? 0, clv, clvN: r?.clvN ?? 0, games: r?.games ?? 0, openPnl: o?.pnl ?? 0, openGames: o?.games.size ?? 0 };
  }).sort((a, b) => b.realized + b.openPnl - (a.realized + a.openPnl));

  // the same grid for every sport at once, so you can see where each syndicate makes its money
  const grid: Record<string, Record<string, number>> = {};
  if (!sport) {
    for (const r of results) for (const [sid, v] of Object.entries(r.syn)) ((grid[sid] ??= {})[r.sport] = (grid[sid]?.[r.sport] ?? 0) + v.pnl);
  }
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="sports" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">By sport</h2>
          <div className="flex gap-1 text-[11px]">
            <Link href="/syndicates/sports" className={`rounded px-2.5 py-1 ${!sport ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All sports</Link>
            {SPORTS.map((s) => <Link key={s} href={`/syndicates/sports?sport=${s}`} className={`rounded px-2.5 py-1 ${sport === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{SPORT[s]}</Link>)}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="bg-surface text-left text-muted">
              <tr>
                <th className="px-3 py-2">#</th><th className="px-3 py-2">Firm</th>
                <th className="px-3 py-2 text-right" title="Profit banked on finished games">Realized</th>
                <th className="px-3 py-2 text-right" title="Valued at DraftKings' price; not money yet">Open P&amp;L</th>
                <th className="px-3 py-2 text-right">Units traded</th>
                <th className="px-3 py-2 text-right" title="Average closing-line value on settled trades">CLV</th>
                <th className="px-3 py-2 text-right">Games settled</th>
                <th className="px-3 py-2 text-right">Games open</th>
                {!sport && SPORTS.map((s) => <th key={s} className="px-2 py-2 text-right font-medium">{SPORT[s]}</th>)}
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r, i) => (
                <tr key={r.s.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                  <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.s.color }} /><Link href={`/syndicates/${r.s.id}`} className="hover:text-accent">{r.s.name}</Link></td>
                  <td className={`px-3 py-1.5 text-right ${tone(r.realized)}`}>{u(r.realized)}</td>
                  <td className={`px-3 py-1.5 text-right ${tone(r.openPnl)}`}>{u(r.openPnl)}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{Math.round(r.traded).toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-right ${r.clv == null ? "text-muted" : tone(r.clv)}`}>{r.clv == null ? "–" : `${r.clv >= 0 ? "+" : ""}${(r.clv * 100).toFixed(1)}¢`}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{r.games}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{r.openGames}</td>
                  {!sport && SPORTS.map((s) => <td key={s} className={`px-2 py-1.5 text-right ${tone(grid[r.s.id]?.[s] ?? 0)}`}>{grid[r.s.id]?.[s] == null ? "" : u(grid[r.s.id][s])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-muted">
          Realized is profit banked on games that have finished, from every trade made on them. The sport columns on the right (all-sports view) split that same realized profit so you can see where each trading firm is actually making or losing money. Pick a sport to rank the trading firms in it. Records start building once games settle and are kept permanently.
        </p>
      </main>
    </div>
  );
}
