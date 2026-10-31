import Link from "next/link";

import { Bars } from "@/components/SyndicateCharts";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { takerOf } from "@/lib/syndicateGame";
import { getExchange, getExchangeBoard, getGamesFull, getRecentTrades, label, pct, dkPosted } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const WINDOWS: [string, number][] = [["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168]];
const gameHref = (id: string) => `/syndicates/games/${encodeURIComponent(id)}`;
const n0 = (v: number) => Math.round(v).toLocaleString();

export default async function VolumePage({ searchParams }: { searchParams: Promise<{ h?: string }> }) {
  const sp = await searchParams;
  const hours = WINDOWS.find(([, v]) => String(v) === sp.h)?.[1] ?? 24;
  const [trades, board, { members, syndicates, meta }] = await Promise.all([getRecentTrades(hours), getExchangeBoard(), getExchange()]);
  const games = await getGamesFull([...new Set(trades.map((t) => t.game_id))]);
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));
  const synName = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));

  const totalQty = trades.reduce((a, t) => a + t.qty, 0);
  const cost = trades.reduce((a, t) => a + t.qty * t.price, 0);
  const bucketMs = hours <= 6 ? 600000 : hours <= 48 ? 3600000 : 6 * 3600000;
  const t0 = Math.floor((Date.now() - hours * 3600000) / bucketMs) * bucketMs;
  const nb = Math.ceil((Date.now() - t0) / bucketMs);
  const buckets = Array.from({ length: nb }, (_, i) => ({ ts: t0 + i * bucketMs, v: 0 }));
  for (const t of trades) {
    const i = Math.floor((new Date(t.ts).getTime() - t0) / bucketMs);
    if (i >= 0 && i < nb) buckets[i].v += t.qty;
  }

  const bySport: Record<string, { n: number; qty: number }> = {};
  const byGame: Record<string, { n: number; qty: number; kinds: Record<string, number>; syns: Set<string> }> = {};
  const byContract: Record<string, { gid: string; kind: string; line: number; n: number; qty: number; last: number; takers: Set<string> }> = {};
  for (const t of trades) {
    const g = games[t.game_id];
    const sport = g?.sport ?? t.game_id.split(":")[0];
    (bySport[sport] ??= { n: 0, qty: 0 }).n += 1;
    bySport[sport].qty += t.qty;
    const x = (byGame[t.game_id] ??= { n: 0, qty: 0, kinds: {}, syns: new Set() });
    x.n += 1; x.qty += t.qty; x.kinds[t.kind] = (x.kinds[t.kind] ?? 0) + t.qty;
    x.syns.add(synOf[t.buyer]); x.syns.add(synOf[t.seller]);
    const c = (byContract[`${t.game_id}|${t.kind}|${t.line}`] ??= { gid: t.game_id, kind: t.kind, line: t.line, n: 0, qty: 0, last: t.price, takers: new Set() });
    c.n += 1; c.qty += t.qty; c.takers.add(takerOf(t));
  }
  const topGames = Object.entries(byGame).sort((a, b) => b[1].qty - a[1].qty).slice(0, 10).filter(([id]) => games[id]);
  const topContracts = Object.values(byContract).sort((a, b) => b.qty - a.qty).slice(0, 12).filter((c) => games[c.gid]);

  const gaps = board.filter((g) => dkPosted(g)).flatMap((g) => (g.book ?? []).filter((r) => r[9] != null).map((r) => ({ g, r, d: (r[9]! - r[2]) * 100 })))
    .filter((x) => Math.abs(x.d) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12);

  // main lines where another price disagrees with DraftKings: Kalshi, the exchange, the house, and the syndicates' own views weighted by what they have earned
  const wOf = (sid: string, sport: string) => syndicates.find((s) => s.id === sid)?.learn?.w?.[sport] ?? 0.25;
  const ideas = board.filter((g) => dkPosted(g)).flatMap((g) => (g.views?.lines ?? []).map((ln, i) => {
    const dk = g.views!.r![i];
    const ks = g.views!.kal?.find((x) => x[0] === ln[0] && x[1] === ln[1])?.[2] ?? null;
    const ex = g.views!.x?.[i] ?? null;
    const es = Object.entries(g.views!.e ?? {}).filter(([, v]) => v[i] != null);
    const house = g.views!.e?.house?.[i] ?? null;
    const view = es.length > 0 ? dk + es.reduce((a, [sid, v]) => a + wOf(sid, g.sport) * (v[i] - dk), 0) / es.length : null;
    const gaps = [ks, ex, house, view].map((v) => (v == null ? 0 : (v - dk) * 100));
    return { g, ln, dk, ks, ex, house, view, big: gaps.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) };
  })).filter((x) => Math.abs(x.big) >= 2).sort((a, b) => Math.abs(b.big) - Math.abs(a.big)).slice(0, 15);

  const sharpRows = members.flatMap((m) => Object.entries(m.stats.flow ?? {}).map(([sport, f]) => ({
    m, sport, avg: f.w > 0 ? f.s / f.w : 0, n: f.n, score: m.stats.sharp?.[sport] ?? 0,
  }))).filter((r) => r.n >= 1).sort((a, b) => b.score - a.score || b.avg - a.avg).slice(0, 12);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="volume" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Trading volume</h2>
          <div className="flex gap-1 text-[11px]">
            {WINDOWS.map(([lab, v]) => (
              <Link key={lab} href={`/syndicates/volume?h=${v}`} className={`rounded px-2.5 py-1 ${v === hours ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{lab}</Link>
            ))}
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[["Trades", n0(trades.length)], ["Contracts traded", n0(totalQty)], ["Money changing hands", `${n0(cost)} units`], ["Games traded", String(Object.keys(byGame).length)]].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted">{k}</p>
              <p className="text-lg font-semibold text-foreground">{v}</p>
            </div>
          ))}
        </div>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Contracts traded over time</h3>
          <Bars data={buckets} fmt={n0} timeOpts={{ weekday: hours > 48 ? "short" : undefined, hour: "numeric", minute: hours <= 6 ? "2-digit" : undefined }} />
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted">
            {Object.entries(bySport).sort((a, b) => b[1].qty - a[1].qty).map(([s, v]) => (
              <span key={s}><span className="text-foreground">{SPORT[s] ?? s}</span> {n0(v.qty)} contracts · {n0(v.n)} trades</span>
            ))}
          </div>
        </section>

        <div className="mb-8 grid gap-6 lg:grid-cols-2">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Busiest games</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right">Syndicates</th><th className="px-3 py-2 text-right">Mix</th></tr>
                </thead>
                <tbody className="font-mono">
                  {topGames.length === 0 && <tr><td colSpan={5} className="px-3 py-3 font-sans text-muted">No trades in this window.</td></tr>}
                  {topGames.map(([id, v]) => {
                    const g = games[id];
                    const mix = (["ml", "spread", "total"] as const).map((k) => `${k === "ml" ? "ML" : k === "spread" ? "Sp" : "Tot"} ${Math.round(((v.kinds[k] ?? 0) / v.qty) * 100)}%`).join(" · ");
                    return (
                      <tr key={id} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[g.sport]}</span><Link href={gameHref(id)} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link></td>
                        <td className="px-3 py-1.5 text-right">{v.n}</td>
                        <td className="px-3 py-1.5 text-right">{n0(v.qty)}</td>
                        <td className="px-3 py-1.5 text-right">{v.syns.size}</td>
                        <td className="px-3 py-1.5 text-right text-[10px] text-muted">{mix}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Busiest markets</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr><th className="px-3 py-2">Contract</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right">Takers</th></tr>
                </thead>
                <tbody className="font-mono">
                  {topContracts.length === 0 && <tr><td colSpan={4} className="px-3 py-3 font-sans text-muted">No trades in this window.</td></tr>}
                  {topContracts.map((c) => {
                    const g = games[c.gid];
                    return (
                      <tr key={`${c.gid}${c.kind}${c.line}`} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <Link href={`${gameHref(c.gid)}?c=${c.kind}|${c.line}`} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr} · {label({ kind: c.kind, line: c.line }, g)}</Link>
                        </td>
                        <td className="px-3 py-1.5 text-right">{c.n}</td>
                        <td className="px-3 py-1.5 text-right">{n0(c.qty)}</td>
                        <td className="px-3 py-1.5 text-right">{c.takers.size}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Where the exchange disagrees with DraftKings</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Contract</th><th className="px-3 py-2 text-right">DraftKings</th><th className="px-3 py-2 text-right">Exchange</th><th className="px-3 py-2 text-right">Gap</th><th className="px-3 py-2 text-right">Bid / ask</th></tr>
              </thead>
              <tbody className="font-mono">
                {gaps.length === 0 && <tr><td colSpan={5} className="px-3 py-3 font-sans text-muted">The exchange is within a point of DraftKings everywhere it has a price.</td></tr>}
                {gaps.map(({ g, r, d }) => (
                  <tr key={`${g.id}${r[0]}${r[1]}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[g.sport]}</span><Link href={`${gameHref(g.id)}?c=${r[0]}|${r[1]}`} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr} · {label({ kind: r[0], line: r[1] }, g)}</Link></td>
                    <td className="px-3 py-1.5 text-right text-muted">{pct(r[2])}</td>
                    <td className="px-3 py-1.5 text-right">{pct(r[9])}</td>
                    <td className={`px-3 py-1.5 text-right ${d > 0 ? "text-up" : "text-down"}`}>{d > 0 ? "+" : ""}{d.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{pct(r[3])} / {pct(r[4])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">The exchange price is the size-weighted middle of the best bid and ask, or the last trade. Gaps show where the crowd of syndicates, after weighing their own models and following sharp flow, thinks DraftKings is off.</p>
        </section>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Ideas board: where other prices disagree with DraftKings</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Main line</th><th className="px-3 py-2 text-right">DraftKings</th><th className="px-3 py-2 text-right">Kalshi</th><th className="px-3 py-2 text-right">Exchange</th><th className="px-3 py-2 text-right">House model</th><th className="px-3 py-2 text-right" title="What the syndicates collectively price: DraftKings moved toward each syndicate's own view by the weight that syndicate has earned, averaged">Syndicates blended</th><th className="px-3 py-2 text-right">Biggest gap</th></tr>
              </thead>
              <tbody className="font-mono">
                {ideas.length === 0 && <tr><td colSpan={7} className="px-3 py-3 font-sans text-muted">Everything is within two points of DraftKings.</td></tr>}
                {ideas.map((x) => (
                  <tr key={`${x.g.id}${x.ln[0]}${x.ln[1]}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[x.g.sport]}</span><Link href={`${gameHref(x.g.id)}?c=${x.ln[0]}|${x.ln[1]}`} className="hover:text-accent">{x.g.away.abbr} @ {x.g.home.abbr} · {label({ kind: x.ln[0], line: x.ln[1] }, x.g)}</Link></td>
                    <td className="px-3 py-1.5 text-right text-muted">{pct(x.dk)}</td>
                    <td className="px-3 py-1.5 text-right">{pct(x.ks)}</td>
                    <td className="px-3 py-1.5 text-right">{pct(x.ex)}</td>
                    <td className="px-3 py-1.5 text-right">{pct(x.house)}</td>
                    <td className="px-3 py-1.5 text-right">{pct(x.view)}</td>
                    <td className={`px-3 py-1.5 text-right ${x.big > 0 ? "text-up" : "text-down"}`}>{x.big > 0 ? "+" : ""}{x.big.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">A starting point for digging, not a signal: a price is only worth listening to once it has a record. The blended column moves DraftKings toward each syndicate&rsquo;s view by the model weight that syndicate has earned from finished games, then averages, so it stays close to DraftKings until some of them prove themselves.</p>
        </section>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Sharp money: whose hits the others follow</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Trader</th><th className="px-3 py-2">Sport</th><th className="px-3 py-2 text-right" title="Average closing-line value, in cents per contract, on the trades it chose to hit">Avg CLV</th><th className="px-3 py-2 text-right">Settled hits</th><th className="px-3 py-2 text-right" title="0 to 1: how much weight others give its hits">Sharpness</th></tr>
              </thead>
              <tbody className="font-mono">
                {sharpRows.length === 0 && <tr><td colSpan={5} className="px-3 py-3 font-sans text-muted">No track records yet: a trader&rsquo;s reputation builds as the games it traded finish. Until then nobody&rsquo;s hits move the market.</td></tr>}
                {sharpRows.map((r) => (
                  <tr key={`${r.m.id}${r.sport}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground">{synName[r.m.syndicate_id]} · {r.m.name}</td>
                    <td className="px-3 py-1.5 font-sans text-muted">{SPORT[r.sport]}</td>
                    <td className={`px-3 py-1.5 text-right ${r.avg > 0 ? "text-up" : "text-down"}`}>{(r.avg * 100).toFixed(1)}¢</td>
                    <td className="px-3 py-1.5 text-right">{r.n}</td>
                    <td className="px-3 py-1.5 text-right">{r.score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">When a trader with a good record hits a quote, everyone who follows the flow moves their view of that game a little the same way, so quotes shift and the exchange price moves off DraftKings. A syndicate whose model has proven itself on settled games also counts as sharp. Followers differ in how much attention they pay.</p>
        </section>
      </main>
    </div>
  );
}
