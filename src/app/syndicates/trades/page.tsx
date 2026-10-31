import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { type ExTrade, getExchange, getExchangeGamesByIds, getGameTrades, getTradesPage, getTradesSummary, label, pct, type TradeQuery } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SIZE = 50;
const u = (n: number) => `${n > 0.005 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-muted");
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Params = { c?: string; syndicate?: string; trader?: string; sport?: string; game?: string; status?: string; role?: string; from?: string; to?: string; page?: string };

export default async function TradesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { syndicates, members, meta } = await getExchange();
  const member = members.find((m) => m.id === sp.trader) ?? null;
  const syn = member ? null : syndicates.find((s) => s.id === sp.syndicate) ?? null;
  const o: TradeQuery = {
    member: member?.id,
    syndicate: syn?.id,
    sport: SPORTS.includes(sp.sport ?? "") ? sp.sport : undefined,
    game: sp.game && /^[a-z]+:\d+$/.test(sp.game) ? sp.game : undefined,
    status: sp.status === "open" || sp.status === "settled" ? sp.status : undefined,
    role: (member || syn) && (sp.role === "maker" || sp.role === "taker") ? sp.role : undefined,
    from: sp.from && DAY.test(sp.from) ? sp.from : undefined,
    to: sp.to && DAY.test(sp.to) ? sp.to : undefined,
  };
  // a selection filter, offered once a game is picked: every line traded in that game, labelled with the teams
  const gameTrades = o.game ? await getGameTrades(o.game) : [];
  const gameInfo = o.game ? (await getExchangeGamesByIds([o.game]))[o.game] : undefined;
  const contracts = [...new Map(gameTrades.map((t) => [`${t.kind}|${t.line}`, { key: `${t.kind}|${t.line}`, kind: t.kind, line: t.line, label: label(t, gameInfo) }])).values()].sort((a, b) => (a.kind === b.kind ? a.line - b.line : a.kind.localeCompare(b.kind)));
  const pickedC = contracts.find((c) => c.key === sp.c);
  if (pickedC) { o.kind = pickedC.kind; o.line = pickedC.line; }
  const page = Math.max(0, Number(sp.page) || 0);
  const mine = (id: string) => (member ? id === member.id : syn ? id.startsWith(`${syn.id}-`) : false);
  const side = (t: ExTrade): "buy" | "sell" | null => {
    const b = mine(t.buyer), s = mine(t.seller);
    return b && !s ? "buy" : s && !b ? "sell" : null; // a trade between two of its own members changes nothing for a syndicate
  };
  const picked = !!(member || syn);
  const [{ rows, total }, summary] = await Promise.all([getTradesPage(o, page, SIZE), picked ? getTradesSummary(o, side) : Promise.resolve(null)]);
  const games = await getExchangeGamesByIds([...new Set(rows.map((t) => t.game_id))]);
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));

  const qs = (over: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { ...sp, ...over };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/trades?${p}`;
  };
  const pages = Math.max(1, Math.ceil(total / SIZE));
  const field = "rounded border border-border bg-background px-2 py-1 text-foreground";
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="trades" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Trade history</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every trade on the exchange, newest first, kept for 120 days. Pick a syndicate or one trader to see each trade from their side: whether they bought or sold, whether they were resting a quote (maker) or hitting one
          (taker), what it made once the game finished, and how the price compared with the close (CLV). Game and sport links from other pages arrive here already filtered.
        </p>

        <form method="get" action="/syndicates/trades" className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-lg border border-border bg-surface px-3 py-3 text-[11px]">
          <label className="flex flex-col gap-1 text-muted">Syndicate
            <select name="syndicate" defaultValue={syn?.id ?? member?.syndicate_id ?? ""} className={field}>
              <option value="">All</option>
              {syndicates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">Trader (overrides syndicate)
            <select name="trader" defaultValue={member?.id ?? ""} className={field}>
              <option value="">Any</option>
              {syndicates.map((s) => (
                <optgroup key={s.id} label={s.name}>
                  {members.filter((m) => m.syndicate_id === s.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">Sport
            <select name="sport" defaultValue={o.sport ?? ""} className={field}>
              <option value="">All</option>
              {SPORTS.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">Status
            <select name="status" defaultValue={o.status ?? ""} className={field}>
              <option value="">Any</option>
              <option value="open">Open (game not finished)</option>
              <option value="settled">Settled</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">Role
            <select name="role" defaultValue={o.role ?? ""} className={field}>
              <option value="">Either</option>
              <option value="maker">Maker (resting quote)</option>
              <option value="taker">Taker (hit a quote)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">From
            <input type="date" name="from" defaultValue={o.from ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-muted">To
            <input type="date" name="to" defaultValue={o.to ?? ""} className={field} />
          </label>
          {o.game && <input type="hidden" name="game" value={o.game} />}
          {o.game && contracts.length > 0 && (
            <label className="flex flex-col gap-1 text-muted">Selection
              <select name="c" defaultValue={pickedC?.key ?? ""} className={field}>
                <option value="">Every selection</option>
                {contracts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          )}
          <button type="submit" className="rounded bg-accent px-3 py-1.5 font-medium text-background">Apply</button>
          <Link href="/syndicates/trades" className="py-1.5 text-muted hover:text-foreground">Clear</Link>
        </form>
        {o.game && (
          <p className="mb-3 text-[11px] text-muted">
            One game only: <span className="text-foreground">{o.game}</span> · <Link href={qs({ game: undefined, page: undefined })} className="text-accent hover:underline">show all games</Link>
          </p>
        )}

        {summary && (
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ["Trades matched", String(summary.n) + (summary.capped ? "+" : "")],
              ["Units put at risk", summary.volume.toFixed(0)],
              ["Settled P&L", summary.settledN ? u(summary.pnl) : "–"],
              ["ROI on those units", summary.settledN && summary.volume > 0 ? `${((summary.pnl / summary.volume) * 100).toFixed(1)}%` : "–"],
              ["Avg CLV per contract", summary.clv == null ? "–" : `${summary.clv >= 0 ? "+" : ""}${(summary.clv * 100).toFixed(1)}¢`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
            ))}
          </div>
        )}
        {summary && <p className="-mt-2 mb-4 text-[11px] text-muted">Settled P&amp;L adds every settled trade matched (a position closed out early counts too), so ROI here divides by all units put at risk, finished or not.{summary.wins + summary.losses > 0 ? ` ${summary.wins} winning and ${summary.losses} losing trades.` : ""}</p>}

        {!rows.length ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No trades match these filters.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1060px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Sport</th>
                  <th className="px-3 py-2">Game</th>
                  <th className="px-3 py-2">Game starts</th>
                  <th className="px-3 py-2">Contract</th>
                  {picked && <th className="px-3 py-2">Side</th>}
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Fair</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  {picked ? <th className="px-3 py-2">Against</th> : <><th className="px-3 py-2">Buyer</th><th className="px-3 py-2">Seller</th></>}
                  <th className="px-3 py-2 text-right">Result</th>
                  {picked && <th className="px-3 py-2 text-right">P&amp;L</th>}
                  {picked && <th className="px-3 py-2 text-right">CLV</th>}
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((t) => {
                  const g = games[t.game_id];
                  const sd = picked ? side(t) : null;
                  const res = t.outcome == null ? "open" : t.outcome === 0.5 ? "push" : t.outcome === 1 ? "yes" : "no";
                  const pnl = sd && t.outcome != null && t.outcome !== 0.5 ? (sd === "buy" ? t.qty * (t.outcome - t.price) : t.qty * (t.price - t.outcome)) : null;
                  const clv = sd && t.close_p != null ? (sd === "buy" ? t.close_p - t.price : t.price - t.close_p) : null;
                  const taker = t.maker === t.buyer ? t.seller : t.buyer;
                  const other = sd === "buy" ? t.seller : t.buyer;
                  const iMaker = sd ? t.maker === (sd === "buy" ? t.buyer : t.seller) : false;
                  return (
                    <tr key={t.id} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-1.5 text-muted"><LocalDateTime iso={t.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                      <td className="px-3 py-1.5 font-sans text-muted">{(g?.sport ?? t.game_id.split(":")[0]).toUpperCase()}</td>
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <Link href={`/syndicates/games/${encodeURIComponent(t.game_id)}`} className="hover:text-accent">{g ? `${g.away.abbr} @ ${g.home.abbr}` : t.game_id}</Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-sans text-muted">{g?.start_utc ? <LocalDateTime iso={g.start_utc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> : "–"}</td>
                      <td className="px-3 py-1.5 font-sans">{label(t, g)}</td>
                      {picked && (
                        <td className="px-3 py-1.5 font-sans">
                          {sd ? <><span className={sd === "buy" ? "text-up" : "text-down"}>{sd === "buy" ? "Bought" : "Sold"}</span> <span className="text-muted">{iMaker ? "maker" : "taker"}</span></> : <span className="text-muted">internal</span>}
                        </td>
                      )}
                      <td className="px-3 py-1.5 text-right">{pct(t.price)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pct(t.ref_p)}</td>
                      <td className="px-3 py-1.5 text-right">{t.qty}</td>
                      {picked ? (
                        <td className="px-3 py-1.5 font-sans text-muted">{sd ? names[other] ?? other : `${names[t.buyer] ?? t.buyer} / ${names[t.seller] ?? t.seller}`}</td>
                      ) : (
                        <>
                          <td className={`px-3 py-1.5 font-sans ${t.maker === t.buyer ? "text-muted" : "text-foreground"}`} title={taker === t.buyer ? "took the quote" : "resting quote"}>{names[t.buyer] ?? t.buyer}</td>
                          <td className={`px-3 py-1.5 font-sans ${t.maker === t.seller ? "text-muted" : "text-foreground"}`}>{names[t.seller] ?? t.seller}</td>
                        </>
                      )}
                      <td className={`px-3 py-1.5 text-right ${res === "open" ? "text-accent" : "text-muted"}`}>{res}</td>
                      {picked && <td className={`px-3 py-1.5 text-right ${pnl == null ? "text-muted" : tone(pnl)}`}>{pnl == null ? "–" : u(pnl)}</td>}
                      {picked && <td className={`px-3 py-1.5 text-right ${clv == null ? "text-muted" : tone(clv)}`}>{clv == null ? "–" : `${clv >= 0 ? "+" : ""}${(clv * 100).toFixed(1)}¢`}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
          <span>{total.toLocaleString()} trades · page {page + 1} of {pages}</span>
          <span className="flex gap-3">
            {page > 0 && <Link href={qs({ page: page > 1 ? String(page - 1) : undefined })} className="hover:text-foreground">← Newer</Link>}
            {page + 1 < pages && <Link href={qs({ page: String(page + 1) })} className="hover:text-foreground">Older →</Link>}
          </span>
        </div>
      </main>
    </div>
  );
}
