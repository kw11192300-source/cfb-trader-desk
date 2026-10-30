import Link from "next/link";
import { notFound } from "next/navigation";

import LocalDateTime from "@/components/LocalDateTime";
import { LineChart, type Dot, type Series } from "@/components/SyndicateCharts";
import { SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { scenarioPnl, scenarios, takerOf, yesNo } from "@/lib/syndicateGame";
import { fairOf, getExchange, getExchangeGame, getGameMarks, getGameTrades, getResult, label, openLots, payoff, ramp, SYN_GAME_LIMIT, type ExGame, type ExTrade, type Lot } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPAN: Record<string, { m: number; t: number }> = { nfl: { m: 30, t: 25 }, cfb: { m: 35, t: 30 }, nba: { m: 30, t: 45 }, cbb: { m: 30, t: 40 }, nhl: { m: 6, t: 4 } };
const range = (a: number, b: number) => Array.from({ length: Math.max(0, Math.round(b - a) + 1) }, (_, i) => a + i);
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");
const cents = (p: number | null | undefined) => (p == null ? "–" : `${Math.round(p * 100)}¢`);
const GROUPS = [["ml", "Winner"], ["spread", "Spread"], ["total", "Total points"]] as const;

export default async function ExchangeGamePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ c?: string; syn?: string }> }) {
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const [game, { syndicates, members, meta }] = await Promise.all([getExchangeGame(id), getExchange()]);
  if (!game) notFound();
  const [trades, marks, result] = await Promise.all([getGameTrades(id), getGameMarks(id), game.completed ? getResult(id) : Promise.resolve(null)]);
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));
  const memberName = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const color = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const synName = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const who = (mid: string) => synOf[mid] ?? null;
  const book = game.book ?? [];
  const kal = (kind: string, line: number): number | null => game.views?.kal?.find((x) => x[0] === kind && x[1] === line)?.[2] ?? null;
  const lots = openLots(trades, who);

  // per-contract totals: traded size, open interest, last price
  const vol: Record<string, { qty: number; n: number; oi: number; last: number | null }> = {};
  for (const t of trades) {
    const v = (vol[`${t.kind}|${t.line}`] ??= { qty: 0, n: 0, oi: 0, last: null });
    v.qty += t.qty; v.n += 1; v.last = t.price;
  }
  for (const l of lots) if (l.qty > 0) (vol[`${l.kind}|${l.line}`] ??= { qty: 0, n: 0, oi: 0, last: null }).oi += l.qty;

  // the contract on show
  const main = (kind: string): number => marks.at(-1)?.lines.find((x) => x[0] === kind)?.[1] ?? (kind === "spread" ? game.ref?.spread ?? 0 : kind === "total" ? game.ref?.total ?? 0 : 0);
  const sel = (() => {
    const [k, l] = (sp.c ?? "").split("|");
    if (k && book.some((b) => b[0] === k && b[1] === Number(l))) return { kind: k, line: Number(l) };
    const pick = book.find((b) => b[0] === "spread" && b[1] === main("spread")) ?? book.find((b) => b[0] === "ml") ?? book[0];
    return pick ? { kind: pick[0], line: pick[1] } : null;
  })();
  const selRow = sel ? book.find((b) => b[0] === sel.kind && b[1] === sel.line) : undefined;
  const selTrades = sel ? trades.filter((t) => t.kind === sel.kind && t.line === sel.line) : [];
  const mainSel = !!sel && sel.line === (sel.kind === "ml" ? 0 : main(sel.kind));
  const dkLine: [number, number][] = [];
  const exLine: [number, number][] = [];
  if (mainSel && sel) {
    for (const mk of marks) {
      const i = mk.lines.findIndex((x) => x[0] === sel.kind);
      if (i < 0) continue;
      dkLine.push([new Date(mk.ts).getTime(), mk.r[i] * 100]);
      if (mk.e && mk.e[i] != null) exLine.push([new Date(mk.ts).getTime(), (mk.e as number[])[i] * 100]);
    }
  }
  const series: Series[] = [];
  if (dkLine.length > 1) series.push({ id: "dk", name: "DraftKings", color: "#a78bfa", pts: dkLine, step: true });
  if (exLine.length > 1) series.push({ id: "ex", name: "Exchange", color: "#34d399", pts: exLine, step: true });
  const dots: Dot[] = selTrades.map((t) => ({ x: new Date(t.ts).getTime(), y: t.price * 100, color: "#38bdf8", r: Math.min(5, 1.5 + t.qty / 40), tip: `${(t.price * 100).toFixed(0)}¢ × ${t.qty.toFixed(0)} · ${names[takerOf(t)] ?? ""} took` }));
  if (series.length === 0 && selRow) series.push({ id: "now", name: "DraftKings now", color: "#a78bfa", pts: [[Date.now() - 3600000, selRow[2] * 100], [Date.now(), selRow[2] * 100]] });

  // positions: one row per trader and contract
  const synFilter = sp.syn && synName[sp.syn] ? sp.syn : null;
  type PosRow = { syn: string; holder: string; kind: ExTrade["kind"]; line: number; net: number; avg: number; yes: number; no: number; mtm: number; now: number | null; dk: number | null };
  const groups: Record<string, Lot[]> = {};
  for (const l of lots) (groups[`${l.holder}|${l.kind}|${l.line}`] ??= []).push(l);
  const posRows: PosRow[] = Object.values(groups).map((ls) => {
    const l0 = ls[0];
    const net = ls.reduce((a, l) => a + l.qty, 0);
    const side = ls.filter((l) => (net >= 0 ? l.qty > 0 : l.qty < 0));
    const avg = side.reduce((a, l) => a + Math.abs(l.qty) * l.price, 0) / Math.max(1e-9, side.reduce((a, l) => a + Math.abs(l.qty), 0));
    const dk = fairOf(game as ExGame, l0.kind, l0.line);
    const mtm = ls.reduce((a, l) => (dk == null ? a : a + (l.qty > 0 ? l.qty * (dk - l.price) : -l.qty * (l.price - dk))), 0);
    const { yes, no } = yesNo(ls);
    const row = book.find((b) => b[0] === l0.kind && b[1] === l0.line);
    return { syn: l0.owner, holder: l0.holder, kind: l0.kind, line: l0.line, net, avg, yes, no, mtm, now: row?.[9] ?? null, dk };
  }).filter((r) => Math.abs(r.net) > 0.5 && (!synFilter || r.syn === synFilter)).sort((a, b) => Math.min(a.yes, a.no) - Math.min(b.yes, b.no)).slice(0, 60);

  // exposure by syndicate: concrete scores, then the charts
  const sc = scenarios(game as ExGame);
  const bySyn: Record<string, Lot[]> = {};
  for (const l of lots) (bySyn[l.owner] ??= []).push(l);
  const synRows = Object.entries(bySyn).map(([sid, ls]) => ({ sid, cells: sc.map((s) => scenarioPnl(ls, s)) })).sort((a, b) => Math.min(...a.cells) - Math.min(...b.cells));
  const span = SPAN[game.sport] ?? SPAN.nba;
  const xm = range(-span.m, span.m), xt = range(Math.round((game.ref?.total ?? 0) - span.t), Math.round((game.ref?.total ?? 0) + span.t));
  const pm = payoff(trades, who, xm, "m"), pt = payoff(trades, who, xt, "t");
  const toSeries = (p: Record<string, number[]>, xs: number[]): Series[] =>
    Object.entries(p).map(([sid, ys]) => ({ id: sid, name: synName[sid] ?? sid, color: color[sid] ?? "#888", pts: xs.map((x, i) => [x, ys[i]] as [number, number]), step: true }));
  const hrs = (new Date(game.start_utc).getTime() - Date.now()) / 3600000;
  const href = (c?: string, syn?: string) => {
    const q = new URLSearchParams();
    if (c) q.set("c", c);
    if (syn) q.set("syn", syn);
    const s = q.toString();
    return `/syndicates/games/${encodeURIComponent(game.id)}${s ? `?${s}` : ""}`;
  };
  const desc = (kind: string, line: number) =>
    kind === "ml" ? `Yes if ${game.home.name} win the game.` : kind === "spread" ? `Yes if ${game.home.name} win by more than ${(-line).toFixed(1).replace(/\.0$/, "")} (or lose by less than ${line.toFixed(1).replace(/\.0$/, "")}).` : `Yes if the teams combine for more than ${line} points.`;

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="markets" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">{game.sport}</p>
            <h2 className="text-xl font-semibold text-foreground">
              {game.away.name} <span className="text-muted">at</span> {game.home.name}
              {game.home_score !== null && game.state !== "pre" && <span className="ml-3 font-mono text-base text-accent">{game.away_score}–{game.home_score}</span>}
            </h2>
            <p className="mt-1 text-xs text-muted">
              <LocalDateTime iso={game.start_utc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
              {game.ref?.src && game.ref.src !== "dk" ? (
                <span className="ml-2 rounded border border-warn/50 px-1.5 py-0.5 text-[10px] text-warn">
                  No DraftKings line yet: the syndicates are making this line. It opened at the ratings&rsquo; consensus ({game.home.abbr} {game.ref.seed ? `${game.ref.seed[0] <= 0 ? "+" : "-"}${Math.abs(game.ref.seed[0]).toFixed(1)}, total ${game.ref.seed[1].toFixed(1)}` : ""}) and trading has moved it to {game.home.abbr} {game.ref.spread != null && game.ref.spread > 0 ? "+" : ""}{game.ref.spread}, total {game.ref.total}. Limits are small.
                </span>
              ) : null}
              {game.ref && (!game.ref.src || game.ref.src === "dk") && (
                <>
                  {" · "}DraftKings {game.ref.spread !== null ? `${game.home.abbr} ${game.ref.spread > 0 ? "+" : ""}${game.ref.spread}` : ""}
                  {game.ref.total !== null ? ` · total ${game.ref.total}` : ""}
                  {game.ref.ml_home !== null ? ` · ML ${game.ref.ml_home > 0 ? "+" : ""}${game.ref.ml_home} / ${game.ref.ml_away! > 0 ? "+" : ""}${game.ref.ml_away}` : ""}
                </>
              )}
            </p>
          </div>
          <p className="text-[11px] text-muted">
            {trades.length} trades · {Math.round(trades.reduce((a, t) => a + t.qty, 0)).toLocaleString()} contracts traded · syndicate limit {Math.round(SYN_GAME_LIMIT * ramp(Math.max(0, hrs)))}-{Math.round(2 * SYN_GAME_LIMIT * ramp(Math.max(0, hrs)) / 1.5)} units now
          </p>
        </div>

        {result && (
          <section className="mb-6 rounded-lg border border-border bg-surface p-4">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Final result: {result.away.abbr} {result.away_score}, {result.home.abbr} {result.home_score}</h3>
            <p className="mb-3 text-[11px] text-muted">What every syndicate and trader actually made or lost on this game, from all {result.n_trades} trades ({Math.round(result.contracts).toLocaleString()} contracts), including positions netted off along the way.</p>
            <div className="grid gap-4 lg:grid-cols-2">
              <table className="w-full text-xs">
                <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Syndicate</th><th className="py-1 text-right font-medium">Profit</th><th className="py-1 text-right font-medium">Traded</th><th className="py-1 text-right font-medium">CLV</th></tr></thead>
                <tbody className="font-mono">
                  {Object.entries(result.syn).sort((a, b) => b[1].pnl - a[1].pnl).map(([sid, v]) => (
                    <tr key={sid} className="border-t border-border">
                      <td className="py-1 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: color[sid] }} />{synName[sid] ?? sid}</td>
                      <td className={`py-1 text-right ${tone(v.pnl)}`}>{u(v.pnl)}</td>
                      <td className="py-1 text-right text-muted">{Math.round(v.traded)}</td>
                      <td className={`py-1 text-right ${v.clv_n ? tone(v.clv_sum / v.clv_n) : "text-muted"}`}>{v.clv_n ? `${v.clv_sum / v.clv_n >= 0 ? "+" : ""}${((v.clv_sum / v.clv_n) * 100).toFixed(1)}¢` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="w-full text-xs">
                <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Traders: best and worst</th><th className="py-1 text-right font-medium">Profit</th></tr></thead>
                <tbody className="font-mono">
                  {(() => {
                    const ts = Object.entries(result.traders ?? {}).sort((a, b) => b[1].pnl - a[1].pnl);
                    return [...ts.slice(0, 5), ...ts.slice(-5)].filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i).map(([mid, v]) => (
                      <tr key={mid} className="border-t border-border"><td className="py-1 font-sans text-foreground"><Link href={`/syndicates/traders/${mid}`} className="hover:text-accent">{names[mid] ?? mid}</Link></td><td className={`py-1 text-right ${tone(v.pnl)}`}>{u(v.pnl)}</td></tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {sel && selRow && (
          <section className="mb-6 rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <div>
                <p className="text-base font-semibold text-foreground">{label(sel, game as ExGame)}</p>
                <p className="text-[11px] text-muted">{desc(sel.kind, sel.line)}</p>
              </div>
              <div className="flex items-baseline gap-4">
                <span className="text-4xl font-semibold text-foreground">{Math.round((selRow[9] ?? selRow[2]) * 100)}%</span>
                <span className="text-xs text-muted">DraftKings {Math.round(selRow[2] * 100)}%{kal(selRow[0], selRow[1]) != null ? ` · Kalshi ${Math.round(kal(selRow[0], selRow[1])! * 100)}%` : ""} · last trade {cents(selRow[5] ?? vol[`${sel.kind}|${sel.line}`]?.last)}</span>
              </div>
            </div>
            <LineChart series={series} dots={dots} height={340} legend={false} xFmt={fmtTime} yFmt={(v) => `${v.toFixed(0)}¢`} />
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
              <span><span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: "#a78bfa" }} />DraftKings</span>
              <span><span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: "#34d399" }} />Exchange price</span>
              <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: "#38bdf8" }} />Trades (bigger dot, bigger trade)</span>
              {!mainSel && <span>Only the main lines keep a price history, so this line shows its trades.</span>}
            </div>
          </section>
        )}

        <div className="mb-8 grid gap-6 lg:grid-cols-5">
          <section className="lg:col-span-3">
            {GROUPS.map(([kind, title]) => {
              const rows = book.filter((b) => b[0] === kind).sort((a, b) => a[1] - b[1]);
              if (!rows.length) return null;
              return (
                <div key={kind} className="mb-4 overflow-hidden rounded-lg border border-border bg-surface">
                  <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">{title}</div>
                  <table className="w-full text-xs">
                    <thead className="text-left text-[10px] uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Contract</th>
                        <th className="px-2 py-1.5 text-right font-medium">Chance</th>
                        <th className="px-2 py-1.5 text-right font-medium">Buy yes</th>
                        <th className="px-2 py-1.5 text-right font-medium">Buy no</th>
                        <th className="px-2 py-1.5 text-right font-medium">Traded</th>
                        <th className="px-3 py-1.5 text-right font-medium">Open</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {rows.map((r) => {
                        const v = vol[`${r[0]}|${r[1]}`];
                        const on = sel && sel.kind === r[0] && sel.line === r[1];
                        const chance = r[9] ?? r[2];
                        const dif = r[9] != null ? (r[9] - r[2]) * 100 : null;
                        return (
                          <tr key={`${r[0]}${r[1]}`} className={`border-t border-border ${on ? "bg-surface-raised" : "hover:bg-surface-raised/60"}`}>
                            <td className="px-3 py-1.5 font-sans">
                              <Link href={href(`${r[0]}|${r[1]}`, synFilter ?? undefined)} scroll={false} className={on ? "font-medium text-accent" : "text-foreground hover:text-accent"}>
                                {label({ kind: r[0], line: r[1] }, game as ExGame)}
                              </Link>
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <span className="text-sm text-foreground">{Math.round(chance * 100)}%</span>
                              <span className="ml-1 text-[10px] text-muted">DK {Math.round(r[2] * 100)}%{kal(r[0], r[1]) != null ? ` · KS ${Math.round(kal(r[0], r[1])! * 100)}%` : ""}{dif != null && Math.abs(dif) >= 1 ? ` · ${dif > 0 ? "+" : ""}${dif.toFixed(0)}` : ""}</span>
                            </td>
                            <td className="px-2 py-1.5 text-right"><span className="rounded bg-up/15 px-1.5 py-0.5 text-up">{cents(r[4])}</span></td>
                            <td className="px-2 py-1.5 text-right"><span className="rounded bg-down/15 px-1.5 py-0.5 text-down">{r[3] == null ? "–" : `${Math.round((1 - r[3]) * 100)}¢`}</span></td>
                            <td className="px-2 py-1.5 text-right text-muted">{v ? Math.round(v.qty).toLocaleString() : ""}</td>
                            <td className="px-3 py-1.5 text-right text-muted">{v?.oi ? Math.round(v.oi).toLocaleString() : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
            <p className="text-[11px] text-muted">Chance is the exchange&rsquo;s own price (the middle of the best bid and ask, or the last trade); DK is DraftKings with the vig removed, and the number after it is how far the exchange is from it in points of probability. Buy yes costs the best ask; buy no costs 100¢ minus the best bid. Click a row to open it.</p>
          </section>

          <section className="lg:col-span-2">
            {sel && selRow ? (
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Order book · {label(sel, game as ExGame)}</p>
                <div className="font-mono text-[11px]">
                  {[...(selRow[10]?.[1] ?? [])].reverse().map(([p, q]) => (
                    <div key={`a${p}`} className="relative flex justify-between px-2 py-0.5">
                      <span className="absolute inset-y-0 right-0 bg-down/15" style={{ width: `${Math.min(100, q / 1.5)}%` }} />
                      <span className="relative text-down">{cents(p)}</span>
                      <span className="relative text-muted">{q}</span>
                    </div>
                  ))}
                  <div className="border-y border-border px-2 py-1 text-center text-[10px] text-muted">spread {selRow[3] != null && selRow[4] != null ? `${Math.round((selRow[4] - selRow[3]) * 100)}¢` : "–"}</div>
                  {(selRow[10]?.[0] ?? []).map(([p, q]) => (
                    <div key={`b${p}`} className="relative flex justify-between px-2 py-0.5">
                      <span className="absolute inset-y-0 right-0 bg-up/15" style={{ width: `${Math.min(100, q / 1.5)}%` }} />
                      <span className="relative text-up">{cents(p)}</span>
                      <span className="relative text-muted">{q}</span>
                    </div>
                  ))}
                </div>
                {(() => {
                  const bl = selRow[10]?.[0] ?? [], al = selRow[10]?.[1] ?? [];
                  if (bl.length + al.length < 2) return null;
                  let cb = 0, ca = 0;
                  const bp: [number, number][] = [...bl].sort((a, b) => b[0] - a[0]).map(([p, q]) => [p * 100, (cb += q)] as [number, number]).reverse();
                  const ap: [number, number][] = [...al].sort((a, b) => a[0] - b[0]).map(([p, q]) => [p * 100, (ca += q)] as [number, number]);
                  return (
                    <>
                      <p className="mb-1 mt-4 text-[10px] uppercase tracking-wide text-muted">Depth: total size at this price or better</p>
                      <LineChart legend={false} height={130} yFmt={(v) => v.toFixed(0)} xFmt={(v) => `${v.toFixed(0)}¢`}
                        series={[{ id: "bids", name: "Bids", color: "#34d399", pts: bp, step: true }, { id: "asks", name: "Asks", color: "#f87171", pts: ap, step: true }].filter((s) => s.pts.length > 0)} />
                    </>
                  );
                })()}
                <p className="mb-1 mt-4 text-[10px] uppercase tracking-wide text-muted">Recent trades in this contract</p>
                {selTrades.length === 0 ? (
                  <p className="text-[11px] text-muted">None yet.</p>
                ) : (
                  <ul className="space-y-0.5 text-[11px]">
                    {[...selTrades].reverse().slice(0, 8).map((t) => (
                      <li key={t.id} className="flex justify-between gap-2">
                        <span className="text-foreground">{cents(t.price)} × {t.qty.toFixed(0)}</span>
                        <span className="truncate text-muted">{names[takerOf(t)]?.split(" · ")[1] ?? ""} ({synName[synOf[takerOf(t)]] ?? ""}) took</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-surface p-4 text-xs text-muted">No markets are listed for this game right now.</p>
            )}
          </section>
        </div>

        <section className="mb-8">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Positions</h3>
            <div className="flex flex-wrap gap-1 text-[11px]">
              <Link href={href(sp.c)} scroll={false} className={`rounded px-2 py-1 ${!synFilter ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All</Link>
              {syndicates.filter((s) => lots.some((l) => l.owner === s.id)).map((s) => (
                <Link key={s.id} href={href(sp.c, s.id)} scroll={false} className={`rounded px-2 py-1 ${synFilter === s.id ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.name.split(" ")[0]}
                </Link>
              ))}
            </div>
          </div>
          {posRows.length === 0 ? (
            <p className="text-xs text-muted">No open positions{synFilter ? " for that syndicate" : ""}.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[860px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Syndicate · trader</th>
                    <th className="px-3 py-2">Contract</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2 text-right">Avg price</th>
                    <th className="px-3 py-2 text-right">Exch / DK</th>
                    <th className="px-3 py-2 text-right" title="Profit or loss if the contract resolves yes">If yes</th>
                    <th className="px-3 py-2 text-right" title="Profit or loss if the contract resolves no">If no</th>
                    <th className="px-3 py-2 text-right" title="What this position would make or lose if closed at the DraftKings price now; not money until it is closed or the game settles">Open P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {posRows.map((r) => (
                    <tr key={`${r.holder}${r.kind}${r.line}`} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: color[r.syn] }} />
                        {synName[r.syn]} <span className="text-muted">· {memberName[r.holder]}</span>
                      </td>
                      <td className="px-3 py-1.5 font-sans">
                        <Link href={href(`${r.kind}|${r.line}`, synFilter ?? undefined)} scroll={false} className="hover:text-accent">{label(r, game as ExGame)}</Link>
                      </td>
                      <td className={`px-3 py-1.5 font-sans ${r.net > 0 ? "text-up" : "text-down"}`}>{r.net > 0 ? "Long yes" : "Short yes (long no)"}</td>
                      <td className="px-3 py-1.5 text-right">{Math.abs(r.net).toFixed(0)}</td>
                      <td className="px-3 py-1.5 text-right">{cents(r.avg)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{cents(r.now)} / {cents(r.dk)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(r.yes)}`}>{u(r.yes)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(r.no)}`}>{u(r.no)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(r.mtm)}`}>{u(r.mtm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted">Each row is one trader&rsquo;s net position in one contract. &ldquo;If yes&rdquo; and &ldquo;if no&rdquo; are what that position makes or loses on its own if the contract resolves either way; positions in different lines partly offset each other, which the score table below shows together.</p>
        </section>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">If it ends like this, each syndicate makes or loses</h3>
          {synRows.length === 0 ? (
            <p className="text-xs text-muted">Nobody holds a position on this game yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Syndicate</th>
                    {sc.map((s) => (
                      <th key={s.id} className={`px-2 py-2 text-right font-medium ${s.id === "ov" ? "border-l border-border" : ""}`}>{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {synRows.map((r) => (
                    <tr key={r.sid} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: color[r.sid] }} />
                        {synName[r.sid]}
                      </td>
                      {r.cells.map((v, i) => (
                        <td key={sc[i].id} className={`px-2 py-1.5 text-right ${tone(v)} ${sc[i].id === "ov" ? "border-l border-border" : ""}`}>{u(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted">The first four columns use every moneyline and spread position at that final margin; the last three use the total positions at that combined score. They are separate bets, so a syndicate&rsquo;s overall result is one of each added together.</p>
          {synRows.length > 0 && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] text-muted">Profit or loss at every final margin ({game.home.abbr} minus {game.away.abbr})</p>
                <LineChart series={toSeries(pm, xm)} zero xFmt={(v) => (v > 0 ? `+${v}` : `${v}`)} height={220} />
              </div>
              <div>
                <p className="mb-1 text-[11px] text-muted">Profit or loss at every final total</p>
                <LineChart series={toSeries(pt, xt)} zero height={220} />
              </div>
            </div>
          )}
        </section>

        <TradeList trades={[...trades].reverse().slice(0, 60)} games={{ [game.id]: game as ExGame }} names={names} />
      </main>
    </div>
  );
}
