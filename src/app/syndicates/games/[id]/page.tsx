import { notFound } from "next/navigation";

import LocalDateTime from "@/components/LocalDateTime";
import { LadderDepth, LineChart, type Dot, type Series } from "@/components/SyndicateCharts";
import { SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getExchange, getExchangeGame, getGameMarks, getGameTrades, label, payoff } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPAN: Record<string, { m: number; t: number }> = { nfl: { m: 30, t: 25 }, cfb: { m: 35, t: 30 }, nba: { m: 30, t: 45 }, cbb: { m: 30, t: 40 }, nhl: { m: 6, t: 4 } };
const range = (a: number, b: number) => Array.from({ length: Math.max(0, Math.round(b - a) + 1) }, (_, i) => a + i);
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

export default async function ExchangeGamePage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const [game, { syndicates, members, meta }] = await Promise.all([getExchangeGame(id), getExchange()]);
  if (!game) notFound();
  const [trades, marks] = await Promise.all([getGameTrades(id), getGameMarks(id)]);
  const synOf = Object.fromEntries(members.map((m) => [m.id, m.syndicate_id]));
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const color = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const synName = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const span = SPAN[game.sport] ?? SPAN.nba;
  const mainTotal = game.ref?.total ?? marks.at(-1)?.lines.find((l) => l[0] === "total")?.[1] ?? 0;
  const xm = range(-span.m, span.m);
  const xt = range(Math.round(mainTotal - span.t), Math.round(mainTotal + span.t));
  const who = (mid: string) => synOf[mid] ?? null;
  const pm = payoff(trades, who, xm, "m");
  const pt = payoff(trades, who, xt, "t");
  const toSeries = (p: Record<string, number[]>, xs: number[]): Series[] =>
    Object.entries(p).map(([sid, ys]) => ({ id: sid, name: synName[sid] ?? sid, color: color[sid] ?? "#888", pts: xs.map((x, i) => [x, ys[i]] as [number, number]), step: true }));
  const exposure = syndicates.map((s) => {
    const m = pm[s.id] ?? xm.map(() => 0), t = pt[s.id] ?? xt.map(() => 0);
    return { s, worst: Math.min(...m) + Math.min(...t), best: Math.max(...m) + Math.max(...t) };
  }).filter((e) => e.worst !== 0 || e.best !== 0).sort((a, b) => a.worst - b.worst);

  // fair price over time for the three main contracts, with trades at those exact lines as dots
  const mainOf = (kind: string): number | null => {
    const l = marks.at(-1)?.lines.find((x) => x[0] === kind);
    return l ? l[1] : null;
  };
  const priceCharts = (["ml", "spread", "total"] as const).map((kind) => {
    const idx = (mk: { lines: [string, number][] }) => mk.lines.findIndex((l) => l[0] === kind);
    const line = mainOf(kind);
    const pts: [number, number][] = marks.filter((mk) => idx(mk) >= 0).map((mk) => [new Date(mk.ts).getTime(), mk.r[idx(mk)] * 100]);
    const dots: Dot[] = line === null ? [] : trades.filter((t) => t.kind === kind && t.line === line).map((t) => ({
      x: new Date(t.ts).getTime(), y: t.price * 100, color: "#38bdf8", r: Math.min(5, 1.5 + t.qty / 40), tip: `${(t.price * 100).toFixed(0)}¢ × ${t.qty}`,
    }));
    return { kind, line, pts, dots };
  }).filter((c) => c.pts.length > 0);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="markets" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="text-base font-semibold text-foreground">
          {game.away.name} @ {game.home.name}
          {game.state !== "pre" && game.home_score !== null && <span className="ml-3 font-mono text-sm text-accent">{game.away_score}–{game.home_score}</span>}
        </h2>
        <p className="mb-6 mt-1 text-xs text-muted">
          <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase">{game.sport}</span>
          <LocalDateTime iso={game.start_utc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          {game.ref && (
            <>
              {" · "}DraftKings {game.ref.spread !== null ? `${game.home.abbr} ${game.ref.spread > 0 ? "+" : ""}${game.ref.spread}` : ""}
              {game.ref.total !== null ? ` · total ${game.ref.total}` : ""}
              {game.ref.ml_home !== null ? ` · ML ${game.ref.ml_home > 0 ? "+" : ""}${game.ref.ml_home} / ${game.ref.ml_away! > 0 ? "+" : ""}${game.ref.ml_away}` : ""}
            </>
          )}
        </p>

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Order book</h3>
          {game.book ? <LadderDepth g={game} /> : <p className="text-xs text-muted">No book for this game right now.</p>}
          <p className="mt-2 text-[11px] text-muted">Green is size bid, red is size offered. Fair is the DraftKings price with the vig taken out; last is the most recent trade in the latest round.</p>
        </section>

        {priceCharts.length > 0 && (
          <section className="mb-8">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Price over time (¢)</h3>
            <div className="grid gap-4 lg:grid-cols-3">
              {priceCharts.map((c) => (
                <div key={c.kind}>
                  <p className="mb-1 text-[11px] text-muted">
                    {label({ kind: c.kind, line: c.line ?? 0 }, game)} · fair line, trades as dots
                  </p>
                  <LineChart series={[{ id: c.kind, name: "fair", color: "#a78bfa", pts: c.pts, step: true }]} dots={c.dots} height={170} xFmt={fmtTime} yFmt={(v) => v.toFixed(0)} />
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Who is exposed</h3>
          {exposure.length === 0 ? (
            <p className="text-xs text-muted">Nobody holds a position on this game yet.</p>
          ) : (
            <>
              <div className="mb-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[460px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Syndicate</th>
                      <th className="px-3 py-2 text-right">Worst case</th>
                      <th className="px-3 py-2 text-right">Best case</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {exposure.map((e) => (
                      <tr key={e.s.id} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: e.s.color }} />
                          {e.s.name}
                        </td>
                        <td className={`px-3 py-1.5 text-right ${e.worst < 0 ? "text-down" : "text-up"}`}>{u(e.worst)}</td>
                        <td className={`px-3 py-1.5 text-right ${e.best < 0 ? "text-down" : "text-up"}`}>{u(e.best)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-[11px] text-muted">Profit or loss by final margin ({game.home.abbr} minus {game.away.abbr}): moneyline and spread positions</p>
                  <LineChart series={toSeries(pm, xm)} zero xFmt={(v) => (v > 0 ? `+${v}` : `${v}`)} height={230} />
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-muted">Profit or loss by final total score: total positions</p>
                  <LineChart series={toSeries(pt, xt)} zero height={230} />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted">Open positions only; anything already netted off has been banked and is not in these lines.</p>
            </>
          )}
        </section>

        <TradeList trades={[...trades].reverse().slice(0, 60)} games={{ [game.id]: game }} names={names} />
      </main>
    </div>
  );
}
