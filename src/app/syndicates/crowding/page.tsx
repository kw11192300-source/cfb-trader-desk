import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { scenarioPnl, scenarios } from "@/lib/syndicateGame";
import { getAllOpenTrades, getExchange, getExchangeBoard, getGamesFull, openLots, type Lot } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };

function corr(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 12) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

export default async function CrowdingPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const [{ syndicates, members, meta }, board, open] = await Promise.all([getExchange(), getExchangeBoard(), getAllOpenTrades()]);
  const games = await getGamesFull([...new Set(open.map((t) => t.game_id))]);
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));

  // 1) do the syndicates' own views move together? their gap from DraftKings on every main line, correlated pairwise
  const vec: Record<string, Map<string, number>> = {};
  for (const g of board.filter((x) => !sport || x.sport === sport)) {
    (g.views?.lines ?? []).forEach((ln, i) => {
      const r = g.views!.r![i];
      for (const [sid, v] of Object.entries(g.views!.e ?? {})) if (v[i] != null) (vec[sid] ??= new Map()).set(`${g.id}|${ln[0]}|${ln[1]}`, v[i] - r);
    });
  }
  const ids0 = syndicates.filter((s) => vec[s.id]?.size).map((s) => s.id);
  const C: Record<string, Record<string, number | null>> = {};
  for (const a of ids0) for (const b of ids0) {
    if (a === b) { (C[a] ??= {})[b] = null; continue; }
    const keys = [...vec[a].keys()].filter((k) => vec[b].has(k));
    (C[a] ??= {})[b] = corr(keys.map((k) => vec[a].get(k)!), keys.map((k) => vec[b].get(k)!));
  }
  // a syndicate whose gap from DraftKings never varies (the pure market makers) has no view to compare
  const C0 = (a: string, b: string) => C[a][b];
  const ids = ids0.filter((a) => ids0.some((b) => C0(a, b) != null));
  const mean = (a: string) => { const xs = ids.filter((b) => b !== a).map((b) => C[a][b]).filter((v): v is number => v != null); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
  const avg = ids.map((a) => ({ a, m: mean(a) })).filter((x) => x.m != null).sort((x, y) => (x.m as number) - (y.m as number));
  const nm = (id: string) => syndicates.find((s) => s.id === id)?.name ?? id;
  const bg = (v: number | null) => (v == null ? undefined : { background: v >= 0 ? `rgba(245,158,11,${Math.min(0.55, Math.abs(v) * 0.55)})` : `rgba(56,189,248,${Math.min(0.55, Math.abs(v) * 0.55)})` });

  // 2) are they all on the same side of the same games? each syndicate's lean on a game from its positions
  const lots = openLots(open, (mid) => synOf[mid] ?? null).filter((l) => games[l.gid] && (!sport || games[l.gid].sport === sport));
  const byGame: Record<string, Record<string, Lot[]>> = {};
  for (const l of lots) ((byGame[l.gid] ??= {})[l.owner] ??= []).push(l);
  const crowded = Object.entries(byGame).flatMap(([gid, bs]) => {
    const g = games[gid];
    const sc = scenarios(g);
    return (["m", "t"] as const).map((dim) => {
      const hi = sc.find((s) => s.id === (dim === "m" ? "hb" : "ov"))!, lo = sc.find((s) => s.id === (dim === "m" ? "ab" : "un"))!;
      const leans = Object.entries(bs).map(([sid, ls]) => {
        const x = ls.filter((l) => (l.kind === "total") === (dim === "t"));
        return [sid, scenarioPnl(x, hi) - scenarioPnl(x, lo)] as [string, number];
      }).filter(([, v]) => Math.abs(v) >= 15);
      const up = leans.filter(([, v]) => v > 0), dn = leans.filter(([, v]) => v < 0);
      return { g, dim, up, dn, n: leans.length, size: leans.reduce((a, [, v]) => a + Math.abs(v), 0) };
    });
  }).filter((x) => x.n >= 3).map((x) => ({ ...x, share: Math.max(x.up.length, x.dn.length) / x.n })).sort((a, b) => b.share - a.share || b.n - a.n).slice(0, 15);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="crowding" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Crowding: do the trading firms all want the same thing?</h2>
          <div className="flex gap-1 text-[11px]">
            <Link href="/syndicates/crowding" className={`rounded px-2.5 py-1 ${!sport ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All sports</Link>
            {SPORTS.map((s) => <Link key={s} href={`/syndicates/crowding?sport=${s}`} className={`rounded px-2.5 py-1 ${sport === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{SPORT[s]}</Link>)}
          </div>
        </div>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Views move together?</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">For every main line on the board, how far each trading firm&rsquo;s own model sits from DraftKings. A cell is the correlation between two syndicates&rsquo; gaps: orange means they lean the same way (crowded), blue means opposite, blank means too little overlap. Bright orange all over would mean the exchange is learning little from having many trading firms.</p>
          {ids.length < 2 ? <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">No games on the board with syndicate views yet.</p> : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="text-[10px]">
                  <thead className="bg-surface text-muted">
                    <tr><th className="px-2 py-2"></th>{ids.map((id) => <th key={id} className="px-1.5 py-2 font-medium" title={nm(id)}>{nm(id).split(" ")[0]}</th>)}</tr>
                  </thead>
                  <tbody className="font-mono">
                    {ids.map((a) => (
                      <tr key={a} className="border-t border-border">
                        <td className="whitespace-nowrap px-2 py-1 font-sans text-foreground">{nm(a)}</td>
                        {ids.map((b) => <td key={b} className="px-1.5 py-1 text-center" style={bg(C[a][b])} title={C[a][b] == null ? "" : `${nm(a)} / ${nm(b)}: ${C[a][b]!.toFixed(2)}`}>{C[a][b] == null ? "" : C[a][b]!.toFixed(2).replace("0.", ".").replace("-.", "−.")}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {avg.length > 0 && (
                <p className="mt-2 text-[11px] text-muted">
                  Most independent: <span className="text-foreground">{nm(avg[0].a)}</span> ({(avg[0].m as number).toFixed(2)} on average). Most in the crowd: <span className="text-foreground">{nm(avg[avg.length - 1].a)}</span> ({(avg[avg.length - 1].m as number).toFixed(2)}).
                </p>
              )}
            </>
          )}
        </section>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Most one-sided games</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">Where the trading firms that hold a position all lean the same way. Lean comes from each trading firm&rsquo;s own open positions: how much it makes if the home side wins big (or the total goes well over) versus if the other side does.</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Market</th><th className="px-3 py-2 text-right">Trading firms holding</th><th className="px-3 py-2 text-right">One side</th><th className="px-3 py-2">Who is on it</th></tr></thead>
              <tbody className="font-mono">
                {crowded.length === 0 && <tr><td colSpan={5} className="px-3 py-3 font-sans text-muted">Not enough overlapping positions yet.</td></tr>}
                {crowded.map((x, i) => {
                  const side = x.up.length >= x.dn.length ? x.up : x.dn, isUp = x.up.length >= x.dn.length;
                  const lab = x.dim === "m" ? (isUp ? x.g.home.abbr : x.g.away.abbr) : isUp ? "Over" : "Under";
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[x.g.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(x.g.id)}`} className="hover:text-accent">{x.g.away.abbr} @ {x.g.home.abbr}</Link></td>
                      <td className="px-3 py-1.5 font-sans text-muted">{x.dim === "m" ? "Side" : "Total"}</td>
                      <td className="px-3 py-1.5 text-right">{x.n}</td>
                      <td className="px-3 py-1.5 text-right"><span className={x.share >= 0.8 ? "text-warn" : "text-foreground"}>{side.length} of {x.n}</span> <span className="font-sans text-muted">on {lab}</span></td>
                      <td className="px-3 py-1.5 font-sans text-[11px] text-muted">{side.map(([sid]) => nm(sid).split(" ")[0]).join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
