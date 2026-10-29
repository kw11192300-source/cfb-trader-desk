import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { LadderDepth } from "@/components/SyndicateCharts";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { takerOf } from "@/lib/syndicateGame";
import { type ExGame, getAllOpenTrades, getExchange, getExchangeBoard, getGamesFull, getRecentTrades, label, pct } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT_LABEL: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const gameHref = (id: string, c?: string) => `/syndicates/games/${encodeURIComponent(id)}${c ? `?c=${encodeURIComponent(c)}` : ""}`;
const sgn = (n: number) => `${n > 0 ? "+" : ""}${n}`;
const n0 = (v: number) => Math.round(v).toLocaleString();

const WINDOWS: [string, number][] = [["Next 24 hours", 24], ["Next 2 days", 48], ["Next week", 168], ["Two weeks", 336]];
const srcNote = (g: ExGame) => (g.ref?.src === "kalshi" ? "no DraftKings line yet · baseline from Kalshi" : g.ref?.src === "model" ? "no DraftKings line yet · baseline from our rating models" : null);

export default async function SyndicateMarketsPage({ searchParams }: { searchParams: Promise<{ h?: string; sport?: string; sort?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const hours = WINDOWS.find(([, v]) => String(v) === sp.h)?.[1] ?? (sport ? 168 : 48); // picking one sport can afford to show a whole week
  const explicitH = WINDOWS.some(([, v]) => String(v) === sp.h);
  const byVolume = sp.sort === "volume";
  const [board, recent, open, { meta, members }] = await Promise.all([getExchangeBoard(hours), getRecentTrades(24), getAllOpenTrades(), getExchange()]);
  const games = board.filter((g) => !sport || g.sport === sport);
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));
  const q = (o: { h?: number; sport?: string | null; sort?: string }) => {
    const p = new URLSearchParams();
    const h = o.h ?? hours, s = o.sport === undefined ? sport : o.sport, so = o.sort ?? (byVolume ? "volume" : "time");
    if (h !== (s ? 168 : 48) || (o.h !== undefined && explicitH)) p.set("h", String(h));
    if (s) p.set("sport", s);
    if (so === "volume") p.set("sort", "volume");
    return `/syndicates/markets${p.toString() ? `?${p}` : ""}`;
  };

  // everything traded so far on the games still to be played, by game and by contract
  const gv: Record<string, { n: number; qty: number; oi: number; syns: Set<string> }> = {};
  const cv: Record<string, { gid: string; kind: string; line: number; n: number; qty: number; oi: number; takers: Set<string>; syns: Set<string> }> = {};
  for (const t of open) {
    if (!byId[t.game_id]) continue;
    const g = (gv[t.game_id] ??= { n: 0, qty: 0, oi: 0, syns: new Set() });
    g.n += 1; g.qty += t.qty; g.oi += t.rem_b ?? t.qty; g.syns.add(synOf[t.buyer]); g.syns.add(synOf[t.seller]);
    const c = (cv[`${t.game_id}|${t.kind}|${t.line}`] ??= { gid: t.game_id, kind: t.kind, line: t.line, n: 0, qty: 0, oi: 0, takers: new Set(), syns: new Set() });
    c.n += 1; c.qty += t.qty; c.oi += t.rem_b ?? t.qty; c.takers.add(takerOf(t)); c.syns.add(synOf[t.buyer]); c.syns.add(synOf[t.seller]);
  }
  // trades on games that kick off beyond this window, so nothing that is trading is hidden without a word
  const outsideIds = [...new Set(open.map((t) => t.game_id).filter((id) => !byId[id] && (!sport || id.startsWith(`${sport}:`))))];
  const outside = await getGamesFull(outsideIds);
  const outBy: Record<string, { games: number; trades: number; qty: number; maxH: number }> = {};
  const outG = new Set<string>();
  for (const t of open) {
    const g = outside[t.game_id];
    if (!g || g.state !== "pre") continue;
    const o = (outBy[g.sport] ??= { games: 0, trades: 0, qty: 0, maxH: 0 });
    if (!outG.has(g.id)) { outG.add(g.id); o.games += 1; }
    o.trades += 1; o.qty += t.qty;
    o.maxH = Math.max(o.maxH, (new Date(g.start_utc).getTime() - Date.now()) / 3600000);
  }
  const nextWindow = WINDOWS.find(([, v]) => v > hours && v >= Math.max(0, ...Object.values(outBy).map((o) => o.maxH)))?.[1] ?? 336;
  const ordered = [...games].sort((a, b) => (byVolume ? (gv[b.id]?.qty ?? 0) - (gv[a.id]?.qty ?? 0) : 0));
  const topGames = [...games].filter((g) => gv[g.id]).sort((a, b) => gv[b.id].qty - gv[a.id].qty).slice(0, 8);
  const topContracts = Object.values(cv).sort((a, b) => b.qty - a.qty).slice(0, 10);

  // the all-sports view keeps the last-24-hours panel and the biggest line moves
  const vol: Record<string, { n: number; qty: number; kinds: Record<string, number> }> = {};
  for (const t of recent) {
    const v = (vol[t.game_id] ??= { n: 0, qty: 0, kinds: {} });
    v.n += 1; v.qty += t.qty; v.kinds[t.kind] = (v.kinds[t.kind] ?? 0) + t.qty;
  }
  const top24 = Object.entries(vol).sort((a, b) => b[1].qty - a[1].qty).slice(0, 8).filter(([id]) => byId[id]);
  const moves = games
    .map((g) => ({ g, ds: g.ref && g.ref_open && g.ref.spread !== null && g.ref_open.spread !== null ? g.ref.spread - g.ref_open.spread : 0, dt: g.ref && g.ref_open && g.ref.total !== null && g.ref_open.total !== null ? g.ref.total - g.ref_open.total : 0 }))
    .filter((m) => m.ds !== 0 || m.dt !== 0)
    .sort((a, b) => Math.abs(b.ds) + Math.abs(b.dt) / 2 - (Math.abs(a.ds) + Math.abs(a.dt) / 2))
    .slice(0, 8);
  const sports = SPORTS.filter((s) => ordered.some((g) => g.sport === s));

  const gameCard = (g: ExGame) => {
    const v = gv[g.id];
    return (
      <section key={g.id} className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">
            <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span>
            <Link href={gameHref(g.id)} className="hover:text-accent">
              {g.away.name} @ {g.home.name}
            </Link>
            <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-normal ${v ? "bg-accent/15 text-accent" : "border border-border text-muted"}`}>
              {v ? `${n0(v.qty)} contracts · ${v.n} trades · ${v.syns.size} syndicates` : "no trades yet"}
            </span>
            {srcNote(g) && <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted">{srcNote(g)}</span>}
          </h3>
          <span className="text-[11px] text-muted">
            <LocalDateTime iso={g.start_utc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          </span>
        </div>
        <LadderDepth g={g} />
      </section>
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="markets" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1">
            <Link href={q({ sport: null })} className={`rounded px-2.5 py-1 ${!sport ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All sports</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={`rounded px-2.5 py-1 ${sport === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{SPORT_LABEL[s]}</Link>)}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {WINDOWS.map(([lab, v]) => <Link key={v} href={q({ h: v })} className={`rounded px-2.5 py-1 ${v === hours ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{lab}</Link>)}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">Order by</span>
            <Link href={q({ sort: "time" })} className={`rounded px-2.5 py-1 ${!byVolume ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>Kickoff</Link>
            <Link href={q({ sort: "volume" })} className={`rounded px-2.5 py-1 ${byVolume ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>Most traded</Link>
          </div>
        </div>

        {Object.keys(outBy).length > 0 && hours < 336 && (
          <p className="mb-5 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted">
            Also trading, but kicking off after this window:{" "}
            {Object.entries(outBy).map(([s, o]) => `${SPORT_LABEL[s]} ${o.games} game${o.games > 1 ? "s" : ""} (${o.trades} trades, ${n0(o.qty)} contracts)`).join(" · ")}.{" "}
            <Link href={q({ h: nextWindow })} className="text-accent hover:underline">Show {WINDOWS.find(([, v]) => v === nextWindow)?.[0].toLowerCase()}</Link>
          </p>
        )}

        {sport ? (
          <div className="mb-8 grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Most active {SPORT_LABEL[sport]} games</h2>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right">Syndicates</th></tr></thead>
                  <tbody className="font-mono">
                    {topGames.length === 0 && <tr><td colSpan={4} className="px-3 py-3 font-sans text-muted">No {SPORT_LABEL[sport]} trades in this window yet.</td></tr>}
                    {topGames.map((g) => (
                      <tr key={g.id} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground"><Link href={gameHref(g.id)} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link></td>
                        <td className="px-3 py-1.5 text-right">{gv[g.id].n}</td>
                        <td className="px-3 py-1.5 text-right">{n0(gv[g.id].qty)}</td>
                        <td className="px-3 py-1.5 text-right">{gv[g.id].syns.size}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Contracts with the most action</h2>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Contract</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right" title="Contracts still held, one side">Open</th><th className="px-3 py-2 text-right" title="Different traders who hit a quote on it">Takers</th><th className="px-3 py-2 text-right">DK / Exch</th></tr></thead>
                  <tbody className="font-mono">
                    {topContracts.length === 0 && <tr><td colSpan={6} className="px-3 py-3 font-sans text-muted">Nothing traded yet.</td></tr>}
                    {topContracts.map((c) => {
                      const g = byId[c.gid];
                      const row = g.book?.find((b) => b[0] === c.kind && b[1] === c.line);
                      return (
                        <tr key={`${c.gid}${c.kind}${c.line}`} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><Link href={gameHref(c.gid, `${c.kind}|${c.line}`)} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr} · {label({ kind: c.kind, line: c.line }, g)}</Link></td>
                          <td className="px-3 py-1.5 text-right">{c.n}</td>
                          <td className="px-3 py-1.5 text-right">{n0(c.qty)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{n0(c.oi)}</td>
                          <td className="px-3 py-1.5 text-right">{c.takers.size}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{pct(row?.[2])} / {pct(row?.[9])}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : (
          <div className="mb-8 grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Most traded, last 24 hours</h2>
              {top24.length === 0 ? (
                <p className="text-xs text-muted">No trades yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right">Mix</th></tr></thead>
                    <tbody className="font-mono">
                      {top24.map(([id, v]) => {
                        const g = byId[id];
                        const mix = (["ml", "spread", "total"] as const).map((k) => `${k === "ml" ? "ML" : k === "spread" ? "Sp" : "Tot"} ${Math.round(((v.kinds[k] ?? 0) / v.qty) * 100)}%`).join(" · ");
                        return (
                          <tr key={id} className="border-t border-border">
                            <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span><Link href={gameHref(id)} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link></td>
                            <td className="px-3 py-1.5 text-right">{v.n}</td>
                            <td className="px-3 py-1.5 text-right">{n0(v.qty)}</td>
                            <td className="px-3 py-1.5 text-right text-[10px] text-muted">{mix}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-1 text-[11px] text-muted">Pick a sport above to see its busiest games and the contracts with the most action.</p>
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Biggest DraftKings moves since open</h2>
              {moves.length === 0 ? (
                <p className="text-xs text-muted">No line has moved yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2 text-right">Spread</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
                    <tbody className="font-mono">
                      {moves.map(({ g }) => (
                        <tr key={g.id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span><Link href={gameHref(g.id)} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link></td>
                          <td className="px-3 py-1.5 text-right">{g.ref_open?.spread != null ? `${sgn(g.ref_open.spread)} → ${sgn(g.ref!.spread!)}` : "–"}</td>
                          <td className="px-3 py-1.5 text-right">{g.ref_open?.total != null ? `${g.ref_open.total} → ${g.ref!.total}` : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Each game lists a moneyline and a ladder of spread and total lines around the baseline price. The badge beside a matchup is everything traded on that game so far. Games
          further out have small limits; ones DraftKings has not priced yet start from Kalshi or our own ratings, and the exchange builds the line from there. The depth bars show how
          much is bid (green) and offered (red) at the best prices after the latest round. Click a game for its price history and who is exposed.
        </p>
        {games.length === 0 && <p className="text-sm text-muted">No games on the exchange in this window.</p>}
        {byVolume ? (
          <div className="space-y-3">{ordered.map(gameCard)}</div>
        ) : (
          sports.map((s) => (
            <div key={s} className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-foreground">{SPORT_LABEL[s]}</h2>
              <div className="space-y-3">{ordered.filter((g) => g.sport === s).map(gameCard)}</div>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
