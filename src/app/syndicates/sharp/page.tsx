import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { rankIn, sharpOf, TIERS, tierOf } from "@/components/SharpMoney";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { gameCards } from "@/lib/positions";
import { fairOf, getAllOpenTrades, getExchange, getGamesFull, getPiles, type Lot, openLots, pct, TRADER_GAME_LIMIT } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const MIN: [string, string, number][] = [["sharp", "Sharp", 0.5], ["leaning", "Leaning sharp or better", 0.2], ["any", "Any record", 0.05]];
const SORT: [string, string][] = [["lev", "% of limit"], ["units", "Units at risk"], ["weighted", "Sharpness × size"]];
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
type Params = { sport?: string; min?: string; sort?: string; t?: string };
const THRS = [3, 5, 10, 20, 40];
const GROUPS: [string, string][] = [["sport:cfb", "CFB"], ["sport:nfl", "NFL"], ["sport:nhl", "NHL"], ["sport:nba", "NBA"], ["sport:cbb", "CBB"], ["kind:ml", "Moneyline"], ["kind:spread", "Spread"], ["kind:total", "Total"],
  ["hrs:>24", "More than 24h before"], ["hrs:6-24", "6 to 24h before"], ["hrs:<6", "Under 6h before"], ["top:<0.3", "Sharpest account under 0.3"], ["top:0.3-0.5", "Sharpest account 0.3 to 0.5"], ["top:>=0.5", "Sharpest account 0.5+"],
  ["against:none", "No sharp account against"], ["against:some", "Some sharp account against"]];
const COST = 0.015; // roughly the half-spread paid to get in on the exchange
const cstat = (c: number[] | undefined) => {
  if (!c || c[0] === 0) return null;
  const n = c[0], m = c[2] / n, v = Math.max(0, c[3] / n - m * m), se = n > 1 ? Math.sqrt(v / n) : null;
  const nc = c[6], mc = nc ? c[4] / nc : null, sec = nc > 1 ? Math.sqrt(Math.max(0, c[5] / nc - (mc ?? 0) ** 2) / nc) : null;
  return { n, hit: c[1] / n, m, se, mc, sec, nc };
};
const cents = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}¢`;

export default async function SharpPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const [{ syndicates, members, meta }, open, rec] = await Promise.all([getExchange(), getAllOpenTrades(), getPiles()]);
  const tSel = THRS.includes(Number(sp.t)) ? Number(sp.t) : 10;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const minKey = MIN.find((m) => m[0] === sp.min)?.[0] ?? "leaning";
  const minVal = MIN.find((m) => m[0] === minKey)![2];
  const sortKey = SORT.find((s) => s[0] === sp.sort)?.[0] ?? "lev";
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const synName = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const synColor = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const games = await getGamesFull([...new Set(open.map((t) => t.game_id))]);
  const q = (o: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { sport: sport ?? undefined, min: minKey === "leaning" ? undefined : minKey, sort: sortKey === "lev" ? undefined : sortKey, t: sp.t, ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/sharp${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  const lots = openLots(open, (mid) => (byId[mid] ? mid : null)).filter((l) => games[l.gid] && (!sport || games[l.gid].sport === sport));
  const byHolderGame: Record<string, Lot[]> = {};
  for (const l of lots) (byHolderGame[`${l.holder}|${l.gid}`] ??= []).push(l);

  // each sharp trader's book on each game
  const rows = Object.entries(byHolderGame).flatMap(([key, ls]) => {
    const [holder, gid] = key.split("|");
    const m = byId[holder], g = games[gid];
    const s = sharpOf(m, g.sport);
    if (!m || s < minVal) return [];
    const card = gameCards(ls, { [gid]: g }, fairOf)[0];
    if (!card) return [];
    const limit = TRADER_GAME_LIMIT * (1 + 0.5 * s);
    const used = -card.worst;
    return [{ m, g, gid, s, tier: tierOf(m, g.sport), rank: rankIn(members, m, g.sport), card, limit, used, lev: used / limit, bankroll: m.cash + m.locked }];
  });
  const score = (r: (typeof rows)[number]) => (sortKey === "lev" ? r.lev : sortKey === "units" ? r.used : r.s * r.card.units);
  rows.sort((a, b) => score(b) - score(a));

  // where the sharp money piles up: every sharp trader's contracts on a line, weighted by sharpness
  type Pile = { gid: string; kind: string; line: number; v: number; long: number; short: number; best: string; bestS: number };
  const pile: Record<string, Pile> = {};
  for (const [key, ls] of Object.entries(byHolderGame)) {
    const [holder, gid] = key.split("|");
    const m = byId[holder], g = games[gid];
    const s = sharpOf(m, g.sport);
    if (!m || s < minVal) continue;
    for (const l of ls) {
      const k = `${gid}|${l.kind}|${l.line}`;
      const P = (pile[k] ??= { gid, kind: l.kind, line: l.line, v: 0, long: 0, short: 0, best: "", bestS: 0 });
      P.v += l.qty * s;
      if (l.qty > 0) P.long += 1; else P.short += 1;
      if (s > P.bestS) { P.bestS = s; P.best = holder; }
    }
  }
  const piles = Object.values(pile).filter((p) => Math.abs(p.v) >= 1).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 20);
  const sideWords = (g: (typeof games)[string], kind: string, line: number, v: number) =>
    kind === "ml" ? `${v >= 0 ? g.home.abbr : g.away.abbr} to win` : kind === "spread" ? (v >= 0 ? `${g.home.abbr} ${line > 0 ? "+" : ""}${line}` : `${g.away.abbr} ${-line > 0 ? "+" : ""}${-line}`) : `${v >= 0 ? "Over" : "Under"} ${line}`;
  const eligible = members.filter((m) => !m.params.public && SPORTS.some((s) => sharpOf(m, s) >= minVal)).length;

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="sharp" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Sharp money: where the best accounts are most leveraged</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every open game, filtered to traders whose takes in that sport have a closing-line record (a sharpness score from 0 to 1, per sport). The first table ranks their books on each game by how hard they are leaning:
          the worst case on that game as a share of the trader&rsquo;s per-game limit. The second adds up what all the sharp accounts hold on each line, weighted by how sharp each is, so you can see where they agree.
          The records are young and thin, so read it as a lead for where to look, not as a signal to act on. {eligible} accounts qualify at this setting.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Sharpness</span>
            {MIN.map(([k, name]) => <Link key={k} href={q({ min: k === "leaning" ? undefined : k })} className={chip(minKey === k)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Rank by</span>
            {SORT.map(([k, name]) => <Link key={k} href={q({ sort: k === "lev" ? undefined : k })} className={chip(sortKey === k)}>{name}</Link>)}
          </div>
        </div>

        <h3 className="mb-2 text-sm font-semibold text-foreground">Biggest sharp positions</h3>
        {rows.length === 0 ? (
          <p className="mb-8 rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No account at this sharpness holds an open position{sport ? ` in ${SPORT[sport]}` : ""} right now. Try &ldquo;Any record&rdquo;.</p>
        ) : (
          <div className="mb-8 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[980px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">Trader</th>
                  <th className="px-3 py-2">Sharpness</th>
                  <th className="px-3 py-2">Game</th>
                  <th className="px-3 py-2">Holds</th>
                  <th className="px-3 py-2 text-right" title="Worst case on this game against the trader's per-game limit">Leverage</th>
                  <th className="px-3 py-2 text-right">Best case</th>
                  <th className="px-3 py-2 text-right" title="Marked at DraftKings' current price">Open P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 30).map((r) => (
                  <tr key={`${r.m.id}${r.gid}`} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <Link href={`/syndicates/traders/${r.m.id}`} className="font-medium text-foreground hover:text-accent">{r.m.name}</Link>
                      <span className="block text-[10px] text-muted"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: synColor[r.m.syndicate_id] }} />{synName[r.m.syndicate_id]}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 rounded bg-surface-raised"><div className="h-1.5 rounded" style={{ width: `${r.s * 100}%`, background: TIERS[r.tier].color }} /></div>
                        <span className="font-mono text-[11px] text-foreground">{r.s.toFixed(2)}</span>
                      </div>
                      <span className="text-[10px] text-muted">{TIERS[r.tier].name}{r.rank ? ` · #${r.rank} in ${SPORT[r.g.sport]}` : ""}</span>
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      <span className="mr-1.5 text-[10px] text-muted">{SPORT[r.g.sport]}</span>
                      <Link href={`/syndicates/games/${encodeURIComponent(r.gid)}?col=sharp`} className="hover:text-accent">{r.g.away.abbr} @ {r.g.home.abbr}</Link>
                      <span className="block text-[10px] text-muted"><LocalDateTime iso={r.g.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.card.legs.map((l) => (
                          <span key={`${l.kind}${l.line}`} className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]">
                            <span className="font-medium text-foreground">{l.text}</span>
                            <span className="ml-1 font-mono text-muted">{Math.abs(l.net).toFixed(0)} @ {pct(l.paid)}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      <span className="text-foreground">{r.used.toFixed(0)}</span> <span className="text-muted">/ {r.limit.toFixed(0)}</span>
                      <div className="ml-auto mt-1 h-1 w-16 rounded bg-surface-raised"><div className={`h-1 rounded ${r.lev > 0.9 ? "bg-down" : "bg-accent"}`} style={{ width: `${Math.min(100, r.lev * 100)}%` }} /></div>
                      <span className="text-[10px] text-muted">{(r.lev * 100).toFixed(0)}% of limit · {((r.used / Math.max(1, r.bankroll)) * 100).toFixed(1)}% of bankroll</span>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${tone(r.card.best)}`}>{u(r.card.best)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${tone(r.card.mtm)}`}>{u(r.card.mtm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="mb-1 text-sm font-semibold text-foreground">Where the sharp money is piling up</h3>
        <p className="mb-2 text-[11px] text-muted">Sharp-weighted contracts per line (each trader&rsquo;s contracts multiplied by its sharpness), with how many sharp accounts are on each side. A line with accounts on both sides is a disagreement, not a pile.</p>
        {piles.length === 0 ? (
          <p className="text-xs text-muted">Nothing yet at this setting.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Leaning to</th><th className="px-3 py-2 text-right">Sharp-weighted</th><th className="px-3 py-2 text-right">Accounts for / against</th><th className="px-3 py-2">Sharpest on it</th></tr></thead>
              <tbody>
                {piles.map((p) => {
                  const g = games[p.gid];
                  const forN = p.v >= 0 ? p.long : p.short, againstN = p.v >= 0 ? p.short : p.long;
                  return (
                    <tr key={`${p.gid}${p.kind}${p.line}`} className="border-t border-border">
                      <td className="px-3 py-1.5 text-foreground"><span className="mr-1.5 text-[10px] text-muted">{SPORT[g.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(p.gid)}?col=sharp`} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link></td>
                      <td className="px-3 py-1.5 font-medium text-accent">{sideWords(g, p.kind, p.line, p.v)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{Math.abs(p.v).toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right font-mono"><span className="text-up">{forN}</span> / <span className={againstN ? "text-down" : "text-muted"}>{againstN}</span></td>
                      <td className="px-3 py-1.5 text-muted">{byId[p.best]?.name} <span className="text-[10px]">({p.bestS.toFixed(2)})</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="mb-1 mt-10 text-sm font-semibold text-foreground">Track record: does following a sharp pile beat the market?</h3>
        <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
          Every round, the sharp-weighted pile on each line is measured (the number in the table above). The first time a line&rsquo;s pile on one side reaches a size, DraftKings&rsquo; price is recorded; when the game finishes it is scored.
          <strong> DraftKings moved toward it</strong> is the price check (how the close compared with that price, in the pile&rsquo;s direction, with no luck from the result in it) and <strong>Made</strong> is what a contract on that side earned from that price
          to the final result. The last column takes off about {COST * 100}¢ for the exchange spread you would pay to get in. A size that holds a positive number there across many games is a candidate threshold. Today there are {rec.openCount} piles waiting
          on their games, so this fills in as games finish and nothing here is a result yet. Entries at different sizes come from the same piles, so they overlap rather than add up. Ranges are 95%.
        </p>
        <div className="mb-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Pile reaches</th><th className="px-3 py-2 text-right">Scored</th><th className="px-3 py-2 text-right">Right</th><th className="px-3 py-2 text-right">DraftKings moved toward it</th><th className="px-3 py-2 text-right">Made per contract</th><th className="px-3 py-2 text-right">After the spread</th></tr></thead>
            <tbody className="font-mono">
              {THRS.map((th) => {
                const c = cstat(rec.cells[`${th}|all`]);
                return (
                  <tr key={th} className={`border-t border-border ${th === tSel ? "bg-surface" : ""}`}>
                    <td className="px-3 py-1.5 font-sans"><Link href={q({ t: String(th) })} className="text-foreground hover:text-accent">{th}+ sharp-weighted contracts</Link></td>
                    {c ? (
                      <>
                        <td className="px-3 py-1.5 text-right text-muted">{c.n}</td>
                        <td className="px-3 py-1.5 text-right">{(c.hit * 100).toFixed(0)}%</td>
                        <td className={`px-3 py-1.5 text-right ${c.mc == null ? "text-muted" : tone(c.mc * 100)}`}>{c.mc == null ? "–" : cents(c.mc)}{c.sec != null && <span className="ml-1 text-[10px] text-muted">±{(196 * c.sec).toFixed(1)}</span>}</td>
                        <td className={`px-3 py-1.5 text-right ${tone(c.m * 100)}`}>{cents(c.m)}{c.se != null && <span className="ml-1 text-[10px] text-muted">±{(196 * c.se).toFixed(1)}</span>}</td>
                        <td className={`px-3 py-1.5 text-right ${tone((c.m - COST) * 100)}`}>{cents(c.m - COST)}</td>
                      </>
                    ) : <td colSpan={5} className="px-3 py-1.5 text-center text-muted">nothing scored yet</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mb-2 text-xs text-foreground">Cut by group, for piles of {tSel}+ <span className="text-muted">(pick the size in the table above)</span>:</p>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Group</th><th className="px-3 py-2 text-right">Scored</th><th className="px-3 py-2 text-right">Right</th><th className="px-3 py-2 text-right">DraftKings moved toward it</th><th className="px-3 py-2 text-right">Made per contract</th></tr></thead>
            <tbody className="font-mono">
              {GROUPS.map(([g, name]) => {
                const c = cstat(rec.cells[`${tSel}|${g}`]);
                if (!c) return null;
                return (
                  <tr key={g} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground">{name}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{c.n}</td>
                    <td className="px-3 py-1.5 text-right">{(c.hit * 100).toFixed(0)}%</td>
                    <td className={`px-3 py-1.5 text-right ${c.mc == null ? "text-muted" : tone(c.mc * 100)}`}>{c.mc == null ? "–" : cents(c.mc)}</td>
                    <td className={`px-3 py-1.5 text-right ${tone(c.m * 100)}`}>{cents(c.m)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
