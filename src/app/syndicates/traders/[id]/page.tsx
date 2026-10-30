import Link from "next/link";
import { notFound } from "next/navigation";

import LocalDateTime from "@/components/LocalDateTime";
import { PositionCards } from "@/components/PositionCards";
import { EquityChart, SyndicateHeader, TradeFilters, TradeList } from "@/components/SyndicateParts";
import { scenarioPnl, scenarios, yesNo } from "@/lib/syndicateGame";
import { fairOf, getExchange, getExchangeSnapshots, getExchangeTrades, getGamesFull, getTraderOpenTrades, label, openLots, pct, ramp, TRADER_GAME_LIMIT, type ExGame, type Lot } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");

export default async function TraderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sport?: string; game?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sportF = ["nfl", "cfb", "nhl", "nba", "cbb"].includes(sp.sport ?? "") ? sp.sport! : null;
  const gameF = sp.game && /^[a-z]+:\d+$/.test(sp.game) ? sp.game : null;
  const { syndicates, members, meta } = await getExchange();
  const m = members.find((x) => x.id === id);
  if (!m) notFound();
  const syn = syndicates.find((s) => s.id === m.syndicate_id)!;
  const [open, trades, snaps] = await Promise.all([getTraderOpenTrades(id), getExchangeTrades({ member: id, game: gameF ?? undefined, sport: gameF ? undefined : sportF ?? undefined, limit: gameF ? 300 : sportF ? 150 : 60 }), getExchangeSnapshots(`mem:${id}`)]);
  const games = await getGamesFull([...new Set([...open, ...trades].map((t) => t.game_id))]);
  const names = Object.fromEntries(members.map((x) => [x.id, `${syndicates.find((s) => s.id === x.syndicate_id)?.name ?? ""} · ${x.name}`]));
  const st = m.stats;
  const bankroll = m.cash + m.locked;
  const equity = m.equity ?? bankroll;
  const clvN = st.clv_n, clv = clvN ? st.clv_sum / clvN : null;
  const se = clvN > 1 && (st.clv_sq ?? 0) > 0 ? Math.sqrt(Math.max(0, (st.clv_sq ?? 0) / clvN - (clv ?? 0) ** 2) / clvN) : null;

  const openF = open.filter((t) => (gameF ? t.game_id === gameF : sportF ? t.game_id.startsWith(`${sportF}:`) : true));
  const tradedGames = [...new Set(open.map((t) => t.game_id))].map((gid) => games[gid]).filter(Boolean);
  const lots = openLots(openF, (mid) => (mid === id ? id : null));
  const gids = [...new Set(lots.map((l) => l.gid))];
  const rows = gids.map((gid) => {
    const g = games[gid];
    const mine = lots.filter((l) => l.gid === gid);
    const sc = g ? scenarios(g) : [];
    const cells = sc.map((s) => scenarioPnl(mine, s));
    const sideWorst = Math.min(0, ...cells.slice(0, 4)), totWorst = Math.min(0, ...cells.slice(4));
    const mtm = mine.reduce((a, l) => {
      const f = fairOf(g, l.kind, l.line);
      return f == null ? a : a + (l.qty > 0 ? l.qty * (f - l.price) : -l.qty * (l.price - f));
    }, 0);
    const hrs = g ? (new Date(g.start_utc).getTime() - Date.now()) / 3600000 : 0;
    return { gid, g, sc, cells, worst: sideWorst + totWorst, mtm, limit: TRADER_GAME_LIMIT * ramp(Math.max(0, hrs)) };
  }).filter((r) => r.g).sort((a, b) => a.worst - b.worst);

  type Pos = { gid: string; kind: Lot["kind"]; line: number; ls: Lot[] };
  const pos: Record<string, Pos> = {};
  for (const l of lots) (pos[`${l.gid}|${l.kind}|${l.line}`] ??= { gid: l.gid, kind: l.kind, line: l.line, ls: [] }).ls.push(l);
  const posRows = Object.values(pos).map((p) => {
    const net = p.ls.reduce((a, l) => a + l.qty, 0);
    const g = games[p.gid] as ExGame | undefined;
    const side = p.ls.filter((l) => (net >= 0 ? l.qty > 0 : l.qty < 0));
    const avg = side.reduce((a, l) => a + Math.abs(l.qty) * l.price, 0) / Math.max(1e-9, side.reduce((a, l) => a + Math.abs(l.qty), 0));
    const dk = fairOf(g, p.kind, p.line);
    const mtm = p.ls.reduce((a, l) => (dk == null ? a : a + (l.qty > 0 ? l.qty * (dk - l.price) : -l.qty * (l.price - dk))), 0);
    return { ...p, net, avg, dk, mtm, ...yesNo(p.ls), g };
  }).filter((p) => p.g && Math.abs(p.net) > 0.5).sort((a, b) => Math.min(a.yes, a.no) - Math.min(b.yes, b.no)).slice(0, 60);

  const sharp = Object.entries(st.flow ?? {}).sort((a, b) => (st.sharp?.[b[0]] ?? 0) - (st.sharp?.[a[0]] ?? 0));
  const log = (Array.isArray(m.params.log) ? m.params.log : []) as (string | number)[][];
  const cl = (role: "maker" | "taker") => {
    const n = (st as unknown as Record<string, number | undefined>)[`clv_${role}_n`] ?? 0;
    const s = (st as unknown as Record<string, number | undefined>)[`clv_${role}_sum`] ?? 0;
    return n ? `${s / n >= 0 ? "+" : ""}${((s / n) * 100).toFixed(1)}¢ (${n})` : "–";
  };
  const tiles: [string, string, string?][] = [
    ["Bankroll", bankroll.toFixed(1)],
    ["Realized P&L", u(m.realized), tone(m.realized)],
    ["Open P&L", u(equity - bankroll), tone(equity - bankroll)],
    ["Equity", equity.toFixed(1)],
    ["At risk", (m.open_risk ?? 0).toFixed(1)],
    ["CLV", clv == null ? "–" : `${clv >= 0 ? "+" : ""}${(clv * 100).toFixed(1)}¢${se != null ? ` ±${(1.96 * se * 100).toFixed(1)}` : ""}`],
    ["Quote CLV · adverse selection", cl("maker")],
    ["Hit CLV", cl("taker")],
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="board" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-1 text-xs text-muted">
          <Link href={`/syndicates/${syn.id}`} className="hover:text-accent"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: syn.color }} />{syn.name}</Link>
        </p>
        <h2 className="text-xl font-semibold text-foreground">{m.name}</h2>
        <p className="mb-5 mt-1 text-xs text-muted">
          {m.role === "both" ? "Maker and taker" : m.role === "maker" ? "Market maker" : "Taker"} · focus {Array.isArray(m.params.focus) ? (m.params.focus as string[]).map((x) => x.toUpperCase()).join(", ") : "all sports"}
          {" · "}{st.n_maker} quotes filled, {st.n_taker} quotes hit
        </p>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {tiles.map(([k, v, c]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted">{k}</p>
              <p className={`text-lg font-semibold ${c ?? "text-foreground"}`}>{v}</p>
            </div>
          ))}
        </div>

        <TradeFilters base={`/syndicates/traders/${id}`} sport={sportF} game={gameF} games={tradedGames} />

        <div className="mb-8 grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-border bg-surface p-3 text-xs text-muted">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Strategy</h3>
            <p>
              {m.role !== "maker" ? `Wants a ${(Number(m.params.thr ?? 0) * 100).toFixed(1)}¢ edge · ` : ""}
              {m.role !== "taker" ? `quotes ±${(Number(m.params.half ?? 0) * 100).toFixed(1)}¢ · ` : ""}
              {Math.round(Number(m.params.kelly ?? 0) * 100)}% Kelly · quotes up to {String(m.params.size)} contracts · trusts the syndicate model {Number(m.params.trust ?? 1).toFixed(1)}× · follows sharp flow {Math.round(Number(m.params.follow ?? 0.5) * 100)}%
            </p>
            <p className="mt-1">Limits: {TRADER_GAME_LIMIT} units worst case on a game at kickoff, 30% of bankroll in total, 20% of the starting bankroll held back as cash.</p>
            <p className="mb-1 mt-3 text-[10px] uppercase tracking-wide">Changes it made itself</p>
            {log.length === 0 ? <p>None yet. It reviews its strategy after every 40 settled trades of a kind.</p> : (
              <ul className="space-y-0.5">
                {log.slice(0, 6).map((l, i) => (
                  <li key={i}>{String(l[1]) === "thr" ? "Edge it demands" : "Quote width"} {(Number(l[2]) * 100).toFixed(2)}¢ → {(Number(l[3]) * 100).toFixed(2)}¢ <span className="text-[10px]">(its recent CLV {(Number(l[4]) * 100).toFixed(1)}¢)</span></li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-lg border border-border bg-surface p-3 text-xs text-muted">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Sharpness by sport</h3>
            {sharp.length === 0 ? <p>No track record yet. It builds as the games this trader hit finish; until then nobody&rsquo;s hits move the market.</p> : (
              <table className="w-full text-[11px]">
                <thead className="text-left"><tr><th className="py-0.5 font-medium">Sport</th><th className="py-0.5 text-right font-medium">Avg CLV</th><th className="py-0.5 text-right font-medium">Settled hits</th><th className="py-0.5 pl-3 font-medium">Sharpness</th></tr></thead>
                <tbody className="font-mono">
                  {sharp.map(([sp, f]) => (
                    <tr key={sp} className="border-t border-border">
                      <td className="py-0.5 font-sans text-foreground">{SPORT[sp]}</td>
                      <td className={`py-0.5 text-right ${f.s > 0 ? "text-up" : "text-down"}`}>{f.w > 0 ? `${((f.s / f.w) * 100).toFixed(1)}¢` : "–"}</td>
                      <td className="py-0.5 text-right">{f.n}</td>
                      <td className="py-0.5 pl-3"><div className="h-1.5 w-24 rounded bg-surface-raised"><div className="h-1.5 rounded bg-accent" style={{ width: `${(st.sharp?.[sp] ?? 0) * 100}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <EquityChart snaps={snaps} colors={{ [id]: syn.color }} names={{ [id]: m.name }} start={{ [id]: m.start_units }} />

        <PositionCards lots={lots} games={games} limitOf={(g) => TRADER_GAME_LIMIT * ramp(Math.max(0, (new Date(g.start_utc).getTime() - Date.now()) / 3600000))} title="Open positions by game" />

        <details className="mb-8 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted hover:text-foreground">Detailed tables: risk by game, outcome grid and raw position rows</summary>
          <div className="p-3">
        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Risk by game</h3>
          {rows.length === 0 ? <p className="text-xs text-muted">No open positions.</p> : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[860px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2">Kickoff</th>
                    <th className="px-3 py-2 text-right" title="The worst of the final scores shown to the right, side bets plus total bets; the exchange itself checks every possible result">Worst case</th>
                    <th className="px-3 py-2 text-right">Limit now</th>
                    {["Home wins big", "Home wins close", "Away wins close", "Away wins big"].map((h) => <th key={h} className="px-2 py-2 text-right font-medium">{h}</th>)}
                    <th className="px-3 py-2 text-right">Open P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {rows.map((r) => (
                    <tr key={r.gid} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[r.g!.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(r.gid)}`} className="hover:text-accent">{r.g!.away.abbr} @ {r.g!.home.abbr}</Link></td>
                      <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={r.g!.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></td>
                      <td className="px-3 py-1.5 text-right text-down">{u(r.worst)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{r.limit.toFixed(0)}</td>
                      {r.cells.slice(0, 4).map((v, i) => <td key={i} title={r.sc[i].label} className={`px-2 py-1.5 text-right ${tone(v)}`}>{u(v)}</td>)}
                      <td className={`px-3 py-1.5 text-right ${tone(r.mtm)}`}>{u(r.mtm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Open positions</h3>
          {posRows.length === 0 ? <p className="text-xs text-muted">No open positions.</p> : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Contract</th><th className="px-3 py-2">Side</th><th className="px-3 py-2 text-right">Size</th><th className="px-3 py-2 text-right">Avg price</th><th className="px-3 py-2 text-right">DK</th><th className="px-3 py-2 text-right">If yes</th><th className="px-3 py-2 text-right">If no</th><th className="px-3 py-2 text-right">Open P&amp;L</th></tr>
                </thead>
                <tbody className="font-mono">
                  {posRows.map((p) => (
                    <tr key={`${p.gid}${p.kind}${p.line}`} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/games/${encodeURIComponent(p.gid)}`} className="hover:text-accent">{p.g!.away.abbr} @ {p.g!.home.abbr}</Link></td>
                      <td className="px-3 py-1.5 font-sans">{label(p, p.g)}</td>
                      <td className={`px-3 py-1.5 font-sans ${p.net > 0 ? "text-up" : "text-down"}`}>{p.net > 0 ? "Long yes" : "Short yes (long no)"}</td>
                      <td className="px-3 py-1.5 text-right">{Math.abs(p.net).toFixed(0)}</td>
                      <td className="px-3 py-1.5 text-right">{pct(p.avg)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pct(p.dk)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(p.yes)}`}>{u(p.yes)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(p.no)}`}>{u(p.no)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(p.mtm)}`}>{u(p.mtm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

          </div>
        </details>

        <TradeList trades={trades} games={games} names={names} moreHref={`/syndicates/trades?trader=${id}${gameF ? `&game=${gameF}` : sportF ? `&sport=${sportF}` : ""}`} title={gameF || sportF ? `Trades (${gameF ? "this game" : sportF!.toUpperCase()}) - risk and positions above follow the filter` : "Recent trades"} />
      </main>
    </div>
  );
}
