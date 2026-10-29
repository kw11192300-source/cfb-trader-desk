import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { fairOf, getAllOpenTrades, getExchange, getExchangeBoard, getGamesFull, label, openLots, pct, type ExGame, type Lot } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const href = (gid: string, c?: string) => `/syndicates/games/${encodeURIComponent(gid)}${c ? `?c=${encodeURIComponent(c)}` : ""}`;
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
const REASONABLE = 0.04; // a resting quote counts as reasonable when it is within 4 cents of DraftKings

export default async function PositionsPage({ searchParams }: { searchParams: Promise<{ syn?: string; sport?: string }> }) {
  const sp = await searchParams;
  const [{ syndicates, members, meta }, open, board] = await Promise.all([getExchange(), getAllOpenTrades(), getExchangeBoard()]);
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const synId = syndicates.some((s) => s.id === sp.syn) ? sp.syn! : null;
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));
  const memName = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const synName = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const color = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const games = await getGamesFull([...new Set(open.map((t) => t.game_id))]);
  const boardById = Object.fromEntries(board.map((g) => [g.id, g]));
  const q = (o: { syn?: string | null; sport?: string | null }) => {
    const p = new URLSearchParams();
    const s = o.syn === undefined ? synId : o.syn, sp2 = o.sport === undefined ? sport : o.sport;
    if (s) p.set("syn", s);
    if (sp2) p.set("sport", sp2);
    return `/syndicates/positions${p.toString() ? `?${p}` : ""}`;
  };

  // biggest open positions, per trader and contract, by what is put up behind them
  const lots = openLots(open, (mid) => synOf[mid] ?? null).filter((l) => games[l.gid] && (!sport || games[l.gid].sport === sport) && (!synId || l.owner === synId));
  const grp: Record<string, Lot[]> = {};
  for (const l of lots) (grp[`${l.holder}|${l.gid}|${l.kind}|${l.line}`] ??= []).push(l);
  const pos = Object.values(grp).map((ls) => {
    const l0 = ls[0], g = games[l0.gid] as ExGame;
    const net = ls.reduce((a, l) => a + l.qty, 0);
    const cost = ls.reduce((a, l) => a + (l.qty > 0 ? l.qty * l.price : -l.qty * (1 - l.price)), 0);
    const side = ls.filter((l) => (net >= 0 ? l.qty > 0 : l.qty < 0));
    const avg = side.reduce((a, l) => a + Math.abs(l.qty) * l.price, 0) / Math.max(1e-9, side.reduce((a, l) => a + Math.abs(l.qty), 0));
    const dk = fairOf(boardById[l0.gid] ?? g, l0.kind, l0.line);
    const mtm = ls.reduce((a, l) => (dk == null ? a : a + (l.qty > 0 ? l.qty * (dk - l.price) : -l.qty * (l.price - dk))), 0);
    return { l0, g, net, cost, avg, dk, mtm };
  }).filter((p) => Math.abs(p.net) > 1).sort((a, b) => b.cost - a.cost).slice(0, 25);

  // biggest resting quotes close enough to DraftKings to be worth hitting
  const quotes = board.filter((g) => !sport || g.sport === sport).flatMap((g) => (g.book ?? []).flatMap((r) => {
    const out: { g: ExGame; r: typeof r; side: "offer" | "bid"; p: number; q: number; owner: string }[] = [];
    for (const [i, side] of ([[1, "offer"], [0, "bid"]] as const)) for (const lv of r[10]?.[i] ?? []) out.push({ g, r, side, p: lv[0], q: lv[1], owner: lv[2] ?? "" });
    return out;
  })).filter((x) => x.q >= 40 && Math.abs(x.p - x.r[2]) <= REASONABLE && (!synId || synOf[x.owner] === synId)).sort((a, b) => b.q - a.q).slice(0, 25);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="positions" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Biggest positions and liquidity</h2>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <div className="flex flex-wrap gap-1">
              <Link href={q({ syn: null })} className={`rounded px-2 py-1 ${!synId ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All syndicates</Link>
              {syndicates.map((s) => <Link key={s.id} href={q({ syn: s.id })} className={`rounded px-2 py-1 ${synId === s.id ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />{s.name.split(" ")[0]}</Link>)}
            </div>
            <div className="flex gap-1">
              <Link href={q({ sport: null })} className={`rounded px-2 py-1 ${!sport ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All</Link>
              {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={`rounded px-2 py-1 ${sport === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{SPORT[s]}</Link>)}
            </div>
          </div>
        </div>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Biggest open positions</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[880px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Syndicate · trader</th><th className="px-3 py-2">Game</th><th className="px-3 py-2">Contract</th><th className="px-3 py-2">Side</th><th className="px-3 py-2 text-right">Size</th><th className="px-3 py-2 text-right" title="Units put up behind the position">At stake</th><th className="px-3 py-2 text-right">Avg price</th><th className="px-3 py-2 text-right">DK now</th><th className="px-3 py-2 text-right">Open P&amp;L</th></tr>
              </thead>
              <tbody className="font-mono">
                {pos.length === 0 && <tr><td colSpan={9} className="px-3 py-3 font-sans text-muted">No open positions match.</td></tr>}
                {pos.map((p) => (
                  <tr key={`${p.l0.holder}${p.l0.gid}${p.l0.kind}${p.l0.line}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: color[p.l0.owner] }} />{synName[p.l0.owner]} <Link href={`/syndicates/traders/${p.l0.holder}`} className="text-muted hover:text-accent">· {memName[p.l0.holder]}</Link></td>
                    <td className="px-3 py-1.5 font-sans"><span className="mr-2 text-[10px] text-muted">{SPORT[p.g.sport]}</span><Link href={href(p.l0.gid, `${p.l0.kind}|${p.l0.line}`)} className="hover:text-accent">{p.g.away.abbr} @ {p.g.home.abbr}</Link></td>
                    <td className="px-3 py-1.5 font-sans">{label(p.l0, p.g)}</td>
                    <td className={`px-3 py-1.5 font-sans ${p.net > 0 ? "text-up" : "text-down"}`}>{p.net > 0 ? "Long yes" : "Short yes"}</td>
                    <td className="px-3 py-1.5 text-right">{Math.abs(p.net).toFixed(0)}</td>
                    <td className="px-3 py-1.5 text-right">{p.cost.toFixed(0)}</td>
                    <td className="px-3 py-1.5 text-right">{pct(p.avg)}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{pct(p.dk)}</td>
                    <td className={`px-3 py-1.5 text-right ${tone(p.mtm)}`}>{u(p.mtm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">Ranked by units put up behind each position. Open P&amp;L is valued at the DraftKings price and is not money until the position is closed or the game settles.</p>
        </section>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Biggest resting liquidity</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Contract</th><th className="px-3 py-2">Quote</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-right">Size</th><th className="px-3 py-2 text-right" title="How far the quote is from DraftKings' price, in cents; positive means worse for whoever hits it if they are buying">vs DK</th><th className="px-3 py-2 text-right">Exchange</th><th className="px-3 py-2">Largest quote from</th></tr>
              </thead>
              <tbody className="font-mono">
                {quotes.length === 0 && <tr><td colSpan={8} className="px-3 py-3 font-sans text-muted">No large quotes within {REASONABLE * 100}¢ of DraftKings right now.</td></tr>}
                {quotes.map((x, i) => {
                  const gap = (x.p - x.r[2]) * 100;
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans"><span className="mr-2 text-[10px] text-muted">{SPORT[x.g.sport]}</span><Link href={href(x.g.id, `${x.r[0]}|${x.r[1]}`)} className="text-foreground hover:text-accent">{x.g.away.abbr} @ {x.g.home.abbr}</Link></td>
                      <td className="px-3 py-1.5 font-sans">{label({ kind: x.r[0], line: x.r[1] }, x.g)}</td>
                      <td className={`px-3 py-1.5 font-sans ${x.side === "offer" ? "text-down" : "text-up"}`}>{x.side === "offer" ? "Selling yes" : "Buying yes"}</td>
                      <td className="px-3 py-1.5 text-right">{pct(x.p)}</td>
                      <td className="px-3 py-1.5 text-right text-foreground">{Math.round(x.q).toLocaleString()}</td>
                      <td className={`px-3 py-1.5 text-right ${Math.abs(gap) < 1 ? "text-muted" : ""}`}>{gap > 0 ? "+" : ""}{gap.toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pct(x.r[9])}</td>
                      <td className="px-3 py-1.5 font-sans text-muted">{x.owner && memName[x.owner] ? `${memName[x.owner]} · ${synName[synOf[x.owner]]}` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">The largest unfilled quotes left after the latest round that sit within {REASONABLE * 100}¢ of DraftKings, so anyone hitting them is not paying a silly price. &ldquo;Selling yes&rdquo; is someone offering a large amount; &ldquo;buying yes&rdquo; is someone bidding for one. Size is in contracts at that price level and the name is the biggest single quote there.</p>
        </section>
      </main>
    </div>
  );
}
