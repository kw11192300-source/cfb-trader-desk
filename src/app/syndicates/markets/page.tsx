import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { LadderDepth } from "@/components/SyndicateCharts";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { type ExGame, getExchange, getExchangeBoard, getRecentTrades } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT_LABEL: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const gameHref = (id: string) => `/syndicates/games/${encodeURIComponent(id)}`;
const sgn = (n: number) => `${n > 0 ? "+" : ""}${n}`;

const WINDOWS: [string, number][] = [["Next 24 hours", 24], ["Next 2 days", 48], ["Next week", 168], ["Two weeks", 336]];
const srcNote = (g: ExGame) => (g.ref?.src === "kalshi" ? "no DraftKings line yet · baseline from Kalshi" : g.ref?.src === "model" ? "no DraftKings line yet · baseline from our rating models" : null);

export default async function SyndicateMarketsPage({ searchParams }: { searchParams: Promise<{ h?: string }> }) {
  const sp = await searchParams;
  const hours = WINDOWS.find(([, v]) => String(v) === sp.h)?.[1] ?? 48;
  const [games, trades, { meta }] = await Promise.all([getExchangeBoard(hours), getRecentTrades(24), getExchange()]);
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  // traded size by game over the last day (a contract pays 1 unit, so contracts traded is also the units of payout changing hands)
  const vol: Record<string, { n: number; qty: number; notional: number; kinds: Record<string, number> }> = {};
  for (const t of trades) {
    const v = (vol[t.game_id] ??= { n: 0, qty: 0, notional: 0, kinds: {} });
    v.n += 1;
    v.qty += t.qty;
    v.notional += t.qty * t.price;
    v.kinds[t.kind] = (v.kinds[t.kind] ?? 0) + t.qty;
  }
  const top = Object.entries(vol).sort((a, b) => b[1].qty - a[1].qty).slice(0, 8).filter(([id]) => byId[id]);
  const moves = games
    .map((g) => ({ g, ds: g.ref && g.ref_open && g.ref.spread !== null && g.ref_open.spread !== null ? g.ref.spread - g.ref_open.spread : 0, dt: g.ref && g.ref_open && g.ref.total !== null && g.ref_open.total !== null ? g.ref.total - g.ref_open.total : 0 }))
    .filter((m) => m.ds !== 0 || m.dt !== 0)
    .sort((a, b) => Math.abs(b.ds) + Math.abs(b.dt) / 2 - (Math.abs(a.ds) + Math.abs(a.dt) / 2))
    .slice(0, 8);
  const sports = ["nfl", "cfb", "nhl", "nba", "cbb"].filter((sp) => games.some((g) => g.sport === sp));
  const gameCard = (g: ExGame) => (
    <section key={g.id} className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span>
          <Link href={gameHref(g.id)} className="hover:text-accent">
            {g.away.name} @ {g.home.name}
          </Link>
          {srcNote(g) && <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted">{srcNote(g)}</span>}
        </h3>
        <span className="text-[11px] text-muted">
          <LocalDateTime iso={g.start_utc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
        </span>
      </div>
      <LadderDepth g={g} />
    </section>
  );
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="markets" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-8 grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">Most traded, last 24 hours</h2>
            {top.length === 0 ? (
              <p className="text-xs text-muted">No trades yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Game</th>
                      <th className="px-3 py-2 text-right">Trades</th>
                      <th className="px-3 py-2 text-right">Contracts</th>
                      <th className="px-3 py-2 text-right">Mix</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {top.map(([id, v]) => {
                      const g = byId[id];
                      const mix = (["ml", "spread", "total"] as const).map((k) => `${k === "ml" ? "ML" : k === "spread" ? "Sp" : "Tot"} ${Math.round(((v.kinds[k] ?? 0) / v.qty) * 100)}%`).join(" · ");
                      return (
                        <tr key={id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground">
                            <span className="mr-2 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span>
                            <Link href={gameHref(id)} className="hover:text-accent">
                              {g.away.abbr} @ {g.home.abbr}
                            </Link>
                          </td>
                          <td className="px-3 py-1.5 text-right">{v.n}</td>
                          <td className="px-3 py-1.5 text-right">{Math.round(v.qty).toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-right text-[10px] text-muted">{mix}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">Biggest DraftKings moves since open</h2>
            {moves.length === 0 ? (
              <p className="text-xs text-muted">No line has moved yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Game</th>
                      <th className="px-3 py-2 text-right">Spread</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {moves.map(({ g, ds, dt }) => (
                      <tr key={g.id} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <span className="mr-2 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span>
                          <Link href={gameHref(g.id)} className="hover:text-accent">
                            {g.away.abbr} @ {g.home.abbr}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {g.ref_open?.spread != null ? `${sgn(g.ref_open.spread)} → ${sgn(g.ref!.spread!)}` : "–"}
                        </td>
                        <td className="px-3 py-1.5 text-right">{g.ref_open?.total != null ? `${g.ref_open.total} → ${g.ref!.total}` : "–"}{dt !== 0 && ds === 0 ? "" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted">Show</span>
          {WINDOWS.map(([lab, v]) => <Link key={v} href={`/syndicates/markets?h=${v}`} className={`rounded px-2.5 py-1 ${v === hours ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{lab}</Link>)}
          <span className="text-muted">Games further out have small limits; ones DraftKings has not priced yet start from Kalshi or our own ratings and the exchange builds the line from there.</span>
        </div>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Each game lists a moneyline and a ladder of spread and total lines around DraftKings&rsquo; main number. Fair is the DraftKings price with the vig taken out (a yes
          contract pays 100¢: home wins, home covers, over). The depth bars show how much is bid (green) and offered (red) at the best prices after the latest round.
          Click a game for its price history and who is exposed.
        </p>
        {games.length === 0 && <p className="text-sm text-muted">No games on the exchange yet.</p>}
        {sports.map((sp) => (
          <div key={sp} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-foreground">{SPORT_LABEL[sp]}</h2>
            <div className="space-y-3">{games.filter((g) => g.sport === sp).map(gameCard)}</div>
          </div>
        ))}
      </main>
    </div>
  );
}
