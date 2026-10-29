import Link from "next/link";
import { notFound } from "next/navigation";

import LocalDateTime from "@/components/LocalDateTime";
import { scenarioPnl, scenarios } from "@/lib/syndicateGame";
import { EquityChart, LeaderTable, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import {
  fairOf, getExchange, getExchangeSnapshots, getExchangeTrades, getGamesFull, getSyndicateOpenTrades, label, openLots, payoff, pct, ramp, summarize, SYN_GAME_LIMIT,
} from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPAN: Record<string, { m: number; t: number }> = { nfl: { m: 30, t: 25 }, cfb: { m: 35, t: 30 }, nba: { m: 30, t: 45 }, cbb: { m: 30, t: 40 }, nhl: { m: 6, t: 4 } };
const range = (a: number, b: number) => Array.from({ length: Math.max(0, Math.round(b - a) + 1) }, (_, i) => a + i);
const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };

export default async function SyndicatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { syndicates, members, meta } = await getExchange();
  const syn = syndicates.find((s) => s.id === id);
  if (!syn) notFound();
  const mine = members.filter((m) => m.syndicate_id === id);
  const [snaps, trades, open] = await Promise.all([
    getExchangeSnapshots("mem:" + id + "-"),
    getExchangeTrades({ syndicate: id, limit: 40 }),
    getSyndicateOpenTrades(id),
  ]);
  const games = await getGamesFull([...new Set([...trades, ...open].map((t) => t.game_id))]);
  const { members: mrows } = summarize([syn], mine);
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const first = Object.fromEntries(mine.map((m) => [m.id, m.name]));
  const palette = ["#2563eb", "#7c3aed", "#ea580c", "#059669", "#dc2626"];
  const colors = Object.fromEntries(mine.map((m, i) => [m.id, palette[i % palette.length]]));
  const start = Object.fromEntries(mine.map((m) => [m.id, m.start_units]));

  // risk by game: the syndicate's whole book on each game, every trader added together
  const own = (mid: string) => (mid.startsWith(`${id}-`) ? id : null);
  const lots = openLots(open, own);
  const gids = [...new Set(lots.map((l) => l.gid))];
  const riskRows = gids.map((gid) => {
    const g = games[gid];
    const span = SPAN[g?.sport ?? "nba"] ?? SPAN.nba;
    const mainTotal = g?.ref?.total ?? 0;
    const xm = range(-span.m, span.m), xt = range(Math.round(mainTotal - span.t), Math.round(mainTotal + span.t));
    const tr = open.filter((t) => t.game_id === gid);
    const pm = payoff(tr, own, xm, "m")[id] ?? xm.map(() => 0), pt = payoff(tr, own, xt, "t")[id] ?? xt.map(() => 0);
    const mine_ = lots.filter((l) => l.gid === gid);
    const mtm = mine_.reduce((a, l) => {
      const f = fairOf(g, l.kind, l.line);
      return f == null ? a : a + (l.qty > 0 ? l.qty * (f - l.price) : -l.qty * (l.price - f));
    }, 0);
    const hrs = g ? (new Date(g.start_utc).getTime() - Date.now()) / 3600000 : 0;
    const scs = g ? scenarios(g) : [];
    return { gid, g, scs, scen: scs.map((x) => scenarioPnl(mine_, x)), worst: Math.min(...pm) + Math.min(...pt), best: Math.max(...pm) + Math.max(...pt), mtm, limit: SYN_GAME_LIMIT * ramp(Math.max(0, hrs)), n: mine_.length };
  }).filter((r) => r.g).sort((a, b) => a.worst - b.worst);
  const bySport: Record<string, number> = {};
  for (const r of riskRows) bySport[r.g!.sport] = (bySport[r.g!.sport] ?? 0) + Math.max(0, -r.worst);
  const sportMax = Math.max(1, ...Object.values(bySport));

  // positions: one row per contract, with who holds it
  type Pos = { gid: string; kind: string; line: number; long: number; short: number; longCost: number; shortCost: number; holders: Record<string, number> };
  const pos: Record<string, Pos> = {};
  for (const l of lots) {
    const k = `${l.gid}|${l.kind}|${l.line}`;
    const p = (pos[k] ??= { gid: l.gid, kind: l.kind, line: l.line, long: 0, short: 0, longCost: 0, shortCost: 0, holders: {} });
    if (l.qty > 0) { p.long += l.qty; p.longCost += l.qty * l.price; } else { p.short -= l.qty; p.shortCost -= l.qty * l.price; }
    p.holders[l.holder] = (p.holders[l.holder] ?? 0) + l.qty;
  }
  const worstOf = Object.fromEntries(riskRows.map((r) => [r.gid, r.worst]));
  const posRows = Object.values(pos).filter((p) => games[p.gid]).sort((a, b) => (worstOf[a.gid] ?? 0) - (worstOf[b.gid] ?? 0) || Math.abs(b.long - b.short) - Math.abs(a.long - a.short)).slice(0, 80);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="board" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="text-base font-semibold text-foreground">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: syn.color }} />
          {syn.name}
        </h2>
        <p className="mb-6 mt-1 max-w-3xl text-xs text-muted">{syn.tagline}</p>
        <LeaderTable rows={mrows.map((r) => ({ ...r, color: colors[r.id] ?? r.color }))} title="Traders" />

        {syn.engine === "agent" && (
          <section className="mb-8 rounded-lg border border-border bg-surface p-4">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Research agent</h3>
            <p className="text-xs text-muted">
              Builds its own model from the data pack ({syn.learn?.agent?.lines ? "results, player data and market lines" : "results and player data only - it never sees a betting line"}).
              {" "}Model v{syn.learn?.agent?.version ?? 0}
              {syn.learn?.agent?.published_at && (
                <>
                  , published <LocalDateTime iso={syn.learn.agent.published_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </>
              )}
              . {syn.learn?.agent?.notes ? `Latest change: ${syn.learn.agent.notes}` : ""}
            </p>
            {syn.learn?.agent?.error && <p className="mt-2 text-xs text-down">The model failed on its last run, so this syndicate is abstaining and trading off DraftKings alone: {syn.learn.agent.error.slice(-200)}</p>}
            {syn.learn?.agent?.backtest && (
              <div className="mt-3 overflow-x-auto">
                <p className="mb-1 text-[11px] text-muted">Walk-forward test on games it had not seen (average miss in points, lower is better):</p>
                <table className="w-full min-w-[480px] text-[11px]">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="py-0.5">Sport</th>
                      <th className="py-0.5 text-right">Margin: model</th>
                      <th className="py-0.5 text-right">Elo</th>
                      <th className="py-0.5 text-right">Ridge</th>
                      <th className="py-0.5 text-right">Total: model</th>
                      <th className="py-0.5 text-right">Ridge</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {Object.entries(syn.learn.agent.backtest).filter(([, r]) => r.model).map(([sp, r]) => (
                      <tr key={sp} className="border-t border-border">
                        <td className="py-0.5 font-sans uppercase text-foreground">{sp}</td>
                        <td className={`py-0.5 text-right ${r.model!.margin_mae != null && r.ridge?.margin_mae != null && r.model!.margin_mae < r.ridge.margin_mae ? "text-up" : ""}`}>{r.model!.margin_mae?.toFixed(2)}</td>
                        <td className="py-0.5 text-right text-muted">{r.elo?.margin_mae?.toFixed(2)}</td>
                        <td className="py-0.5 text-right text-muted">{r.ridge?.margin_mae?.toFixed(2)}</td>
                        <td className={`py-0.5 text-right ${r.model!.total_mae != null && r.ridge?.total_mae != null && r.model!.total_mae < r.ridge.total_mae ? "text-up" : ""}`}>{r.model!.total_mae?.toFixed(2)}</td>
                        <td className="py-0.5 text-right text-muted">{r.ridge?.total_mae?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Risk by game</h3>
          <p className="mb-2 text-[11px] text-muted">
            Worst case is the most the syndicate can lose on a game across every possible result, all five traders added together (one trader&rsquo;s long can offset another&rsquo;s short).
            The limit is {SYN_GAME_LIMIT} units at kickoff and is lower earlier, so money is deployed gradually. Each trader is also held to {100} units on a game.
          </p>
          {riskRows.length === 0 ? (
            <p className="text-xs text-muted">No open positions.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
                {Object.entries(bySport).sort((a, b) => b[1] - a[1]).map(([sp, v]) => (
                  <span key={sp} className="flex items-center gap-2">
                    {SPORT[sp]}
                    <span className="inline-block h-2 rounded bg-down/70" style={{ width: `${(v / sportMax) * 80 + 4}px` }} />
                    <span className="font-mono text-foreground">{v.toFixed(0)}</span>
                  </span>
                ))}
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[720px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Game</th>
                      <th className="px-3 py-2">Kickoff</th>
                      <th className="px-3 py-2 text-right">Worst case</th>
                      <th className="px-3 py-2 text-right">Limit now</th>
                      <th className="w-28 px-3 py-2">Used</th>
                      <th className="px-3 py-2 text-right">Best case</th>
                      <th className="px-3 py-2 text-right">Marked</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {riskRows.map((r) => (
                      <tr key={r.gid} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <span className="mr-2 text-[10px] text-muted">{SPORT[r.g!.sport]}</span>
                          <Link href={`/syndicates/games/${encodeURIComponent(r.gid)}`} className="hover:text-accent">
                            {r.g!.away.abbr} @ {r.g!.home.abbr}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 font-sans text-muted">
                          <LocalDateTime iso={r.g!.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} />
                        </td>
                        <td className="px-3 py-1.5 text-right text-down">{u(r.worst)}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{r.limit.toFixed(0)}</td>
                        <td className="px-3 py-1.5">
                          <div className="h-1.5 w-full rounded bg-surface-raised">
                            <div className={`h-1.5 rounded ${-r.worst > r.limit * 0.9 ? "bg-down" : "bg-accent"}`} style={{ width: `${Math.min(100, (-r.worst / Math.max(1, r.limit)) * 100)}%` }} />
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right text-up">{u(r.best)}</td>
                        <td className={`px-3 py-1.5 text-right ${r.mtm >= 0 ? "text-up" : "text-down"}`}>{u(r.mtm)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {riskRows.length > 0 && (
          <section className="mb-8">
            <h3 className="mb-2 text-sm font-semibold text-foreground">If it ends like this</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    {["Home wins big", "Home wins close", "Away wins close", "Away wins big"].map((h) => (
                      <th key={h} className="px-2 py-2 text-right font-medium">{h}</th>
                    ))}
                    {["Total well over", "Total on the line", "Total well under"].map((h, i) => (
                      <th key={h} className={`px-2 py-2 text-right font-medium ${i === 0 ? "border-l border-border" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {riskRows.map((r) => (
                    <tr key={r.gid} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <span className="mr-2 text-[10px] text-muted">{SPORT[r.g!.sport]}</span>
                        <Link href={`/syndicates/games/${encodeURIComponent(r.gid)}`} className="hover:text-accent">{r.g!.away.abbr} @ {r.g!.home.abbr}</Link>
                      </td>
                      {r.scen.map((v, i) => (
                        <td key={r.scs[i].id} title={r.scs[i].label} className={`px-2 py-1.5 text-right ${v > 0.5 ? "text-up" : v < -0.5 ? "text-down" : "text-muted"} ${i === 4 ? "border-l border-border" : ""}`}>
                          {v > 0.5 ? "+" : ""}{v.toFixed(0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-muted">What the syndicate makes or loses on that game at a specific final score (hover a figure for the score). Big and close are set from how much that sport&rsquo;s margins usually vary. The side columns use moneyline and spread positions, the total columns use total positions; they are separate bets, so add one of each for the whole game.</p>
          </section>
        )}

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Open positions</h3>
          {posRows.length === 0 ? (
            <p className="text-xs text-muted">No open positions.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2">Contract</th>
                    <th className="px-3 py-2 text-right">Long</th>
                    <th className="px-3 py-2 text-right">Short</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Avg price</th>
                    <th className="px-3 py-2 text-right">DK fair</th>
                    <th className="px-3 py-2">Held by</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {posRows.map((p) => {
                    const g = games[p.gid];
                    const net = p.long - p.short;
                    const avg = net >= 0 ? (p.long ? p.longCost / p.long : null) : p.short ? p.shortCost / p.short : null;
                    return (
                      <tr key={`${p.gid}${p.kind}${p.line}`} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <Link href={`/syndicates/games/${encodeURIComponent(p.gid)}`} className="hover:text-accent">
                            {g.away.abbr} @ {g.home.abbr}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 font-sans">{label(p, g)}</td>
                        <td className="px-3 py-1.5 text-right text-up">{p.long ? p.long.toFixed(0) : ""}</td>
                        <td className="px-3 py-1.5 text-right text-down">{p.short ? p.short.toFixed(0) : ""}</td>
                        <td className={`px-3 py-1.5 text-right ${net > 0 ? "text-up" : net < 0 ? "text-down" : ""}`}>{net > 0 ? "+" : ""}{net.toFixed(0)}</td>
                        <td className="px-3 py-1.5 text-right">{pct(avg)}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{pct(fairOf(g, p.kind, p.line))}</td>
                        <td className="px-3 py-1.5 font-sans text-[11px] text-muted">
                          {Object.entries(p.holders).map(([h, q]) => `${first[h] ?? h} ${q > 0 ? "+" : ""}${q.toFixed(0)}`).join(" · ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted">Long means holding the yes side (home wins, home covers, over); short means holding the other side. Price is the average paid by the long legs or received by the short legs.</p>
        </section>

        <section className="mb-8">
          <p className="mb-2 text-xs text-muted">
            Model weight is how much of this syndicate&rsquo;s own view goes into its prices (the rest is DraftKings). It starts at 25% and moves only as settled games show
            whether the model beat the market:{" "}
            {["nfl", "cfb", "nhl", "nba", "cbb"].map((sp) => `${sp.toUpperCase()} ${Math.round((syn.learn?.w?.[sp] ?? 0.25) * 100)}%`).join(" · ")}
          </p>
          <div className="grid gap-2 text-xs text-muted sm:grid-cols-2 lg:grid-cols-3">
            {mine.map((m) => (
              <div key={m.id} className="rounded-lg border border-border bg-surface px-3 py-2">
                <p className="font-medium text-foreground">
                  {m.name} <span className="font-normal text-muted">· {m.role === "both" ? "maker + taker" : m.role}</span>
                </p>
                <p className="text-[11px]">Focus: {Array.isArray(m.params.focus) ? (m.params.focus as string[]).map((x) => x.toUpperCase()).join(", ") : "all"}</p>
                <p>
                  {m.role !== "maker" ? `Wants ${(Number(m.params.thr ?? 0) * 100).toFixed(1)}¢ edge · ` : ""}
                  {m.role !== "taker" ? `quotes ±${(Number(m.params.half ?? 0) * 100).toFixed(1)}¢ · ` : ""}
                  {Math.round(Number(m.params.kelly ?? 0) * 100)}% Kelly · trusts the model {Number(m.params.trust ?? 1).toFixed(1)}×
                </p>
                {Array.isArray(m.params.log) && m.params.log.length > 0 && (
                  <p className="mt-1 text-[11px]">
                    Last change: {String((m.params.log as (string | number)[][])[0][1]) === "thr" ? "edge wanted" : "quote width"}{" "}
                    {(Number((m.params.log as (string | number)[][])[0][2]) * 100).toFixed(2)}¢ → {(Number((m.params.log as (string | number)[][])[0][3]) * 100).toFixed(2)}¢
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
        <EquityChart snaps={snaps} colors={colors} names={first} start={start} />
        <TradeList trades={trades} games={games} names={names} />
      </main>
    </div>
  );
}
