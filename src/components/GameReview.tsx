import Link from "next/link";

import { type Discovery, type ExGame, type ExMark, type ExMember, type ExSyndicate, type ExTrade, label } from "@/lib/syndicates";

type Closing = {
  src: string;
  lines: [string, number][];
  dk: number[];
  x: (number | null)[] | null;
  ks: (number | null | undefined)[];
  y: number[];
} | null;

type Result = {
  home: { abbr: string };
  away: { abbr: string };
  home_score: number | null;
  away_score: number | null;
  syn: Record<string, { pnl: number; traded: number }>;
  traders?: Record<string, { pnl: number; traded: number }>;
  closing?: Closing;
};

const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;
const tone = (n: number) => (n > 0.05 ? "text-up" : n < -0.05 ? "text-down" : "text-muted");
const cents = (p: number | null | undefined) => (p == null ? "–" : `${(p * 100).toFixed(0)}¢`);

/** What a finished game was about: how it came out against each contract, who was closer, where the money came from (price versus result), and the best and worst single trades. */
export default function GameReview({ game, result, trades, marks, members, syndicates, discovery }: { game: ExGame; result: Result; trades: ExTrade[]; marks: ExMark[]; members: ExMember[]; syndicates: ExSyndicate[]; discovery: Discovery | null }) {
  const mem = Object.fromEntries(members.map((m) => [m.id, m]));
  const syn = Object.fromEntries(syndicates.map((s) => [s.id, s]));
  const hs = result.home_score ?? 0, as = result.away_score ?? 0;
  const closing = result.closing ?? null;

  // how each contract came out, with the closing prices of each source
  const rows = (closing?.lines ?? []).map(([kind, line], i) => {
    const y = closing!.y[i];
    const dk = closing!.dk[i], x = closing!.x?.[i] ?? null, ks = closing!.ks?.[i] ?? null;
    const first = marks.find((m) => m.lines.some((l) => l[0] === kind));
    const last = [...marks].reverse().find((m) => m.lines.some((l) => l[0] === kind));
    const open = first?.lines.find((l) => l[0] === kind)?.[1], close = last?.lines.find((l) => l[0] === kind)?.[1];
    const text =
      kind === "ml" ? (hs > as ? `${result.home.abbr} won` : `${result.away.abbr} won`) :
      kind === "spread" ? `${y === 1 ? result.home.abbr : result.away.abbr} covered (margin ${hs - as > 0 ? "+" : ""}${hs - as} for ${result.home.abbr})` :
      `${y === 1 ? "Over" : "Under"} (${hs + as} points)`;
    const err = (p: number | null | undefined) => (p == null || y === 0.5 ? null : Math.abs(p - y));
    const best = [["DraftKings", err(dk)], ["Exchange", err(x)], ["Kalshi", err(ks)]].filter((e): e is [string, number] => e[1] != null).sort((a, b) => a[1] - b[1]);
    const closer = y === 0.5 || best.length < 2 || best[0][1] - best[1][1] < 0.005 ? "level" : best[0][0];
    return { kind, line, y, dk, x, ks, text, open, close, closer };
  });

  // price versus result, by firm: closing-line value is the closing price against the price paid; result edge is the result against the closing price
  const per: Record<string, { q: number; clv: number; res: number }> = {};
  const single: { pnl: number; t: ExTrade; side: "buyer" | "seller" }[] = [];
  for (const t of trades) {
    if (t.outcome == null || t.outcome === 0.5) continue;
    for (const side of ["buyer", "seller"] as const) {
      const buy = side === "buyer";
      const m = mem[t[side]];
      if (!m) continue;
      single.push({ pnl: t.qty * (buy ? t.outcome - t.price : t.price - t.outcome), t, side });
      if (t.close_p == null) continue;
      const d = (per[m.syndicate_id] ??= { q: 0, clv: 0, res: 0 });
      d.q += t.qty;
      d.clv += t.qty * (buy ? t.close_p - t.price : t.price - t.close_p);
      d.res += t.qty * (buy ? t.outcome - t.close_p : t.close_p - t.outcome);
    }
  }
  const firms = Object.entries(result.syn).sort((a, b) => b[1].pnl - a[1].pnl);
  const shown = firms.length <= 10 ? firms : [...firms.slice(0, 5), ...firms.slice(-5)];

  // who made it: public money, sharp traders, other makers, other takers
  const group = (m: ExMember): string => (m.params.public ? "Public money" : Number((m.stats.sharp ?? {})[game.sport] ?? 0) >= 0.5 ? "Sharp traders (50+)" : m.role === "taker" ? "Other takers" : "Other makers");
  const groups: Record<string, { pnl: number; n: number }> = {};
  for (const [mid, v] of Object.entries(result.traders ?? {})) {
    const m = mem[mid];
    if (!m) continue;
    const g = (groups[group(m)] ??= { pnl: 0, n: 0 });
    g.pnl += v.pnl;
    g.n += 1;
  }

  const kick = new Date(game.start_utc).getTime();
  single.sort((a, b) => b.pnl - a.pnl);

  // opening, discovery and close: where DraftKings (or, before it posted, the exchange) opened, and where each line finished
  const firstMk = marks[0], lastMk = marks[marks.length - 1];
  const mainAt = (m: ExMark | undefined, kind: string) => m?.lines.find((l) => l[0] === kind)?.[1];
  const mlAt = (m: ExMark | undefined) => {
    const i = m?.lines.findIndex((l) => l[0] === "ml") ?? -1;
    return m && i >= 0 ? m.r[i] : null;
  };
  const homeBy = (v: number) => `${result.home.abbr} by ${v.toFixed(1)}`;
  const d = discovery;
  const gapOpen = (a: number | undefined | null, b: number | undefined | null) => (a == null || b == null ? null : Math.abs(a - b));
  const dSpread = d ? { open: gapOpen(d.seed?.[0], d.dk?.[0]), then: gapOpen(d.internal?.[0], d.dk?.[0]) } : null;
  const dTotal = d ? { open: gapOpen(d.seed?.[1], d.dk?.[1]), then: gapOpen(d.internal?.[1], d.dk?.[1]) } : null;
  const cmp = (after: number, before: number, better: string, worse: string) => (Math.abs(after - before) < 0.05 ? "about the same" : after < before ? better : worse);

  // value picked: the trades whose price beat the closing price by the most, size counted (this is price, not the result)
  const value = single
    .filter((x) => x.t.close_p != null)
    .map((x) => ({ ...x, v: x.t.qty * (x.side === "buyer" ? x.t.close_p! - x.t.price : x.t.price - x.t.close_p!) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 4);
  const line = (x: { pnl: number; t: ExTrade; side: "buyer" | "seller" }) => {
    const m = mem[x.t[x.side]];
    const buy = x.side === "buyer";
    const clv = x.t.close_p == null ? null : buy ? x.t.close_p - x.t.price : x.t.price - x.t.close_p;
    const hrs = (kick - new Date(x.t.ts).getTime()) / 3600000;
    return (
      <li key={`${x.t.id}${x.side}`} className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border py-1.5 text-[11px]">
        <span className="min-w-0">
          <Link href={`/syndicates/traders/${m.id}`} className="text-foreground hover:text-accent">{m.name}</Link>
          <span className="ml-1 text-muted">({syn[m.syndicate_id]?.name})</span>{" "}
          <span className="text-muted">{buy ? "bought" : "sold"} {label({ kind: x.t.kind, line: x.t.line }, game)} {Math.round(x.t.qty)} at {cents(x.t.price)}, {hrs >= 1 ? `${hrs.toFixed(0)}h` : `${Math.max(0, hrs * 60).toFixed(0)}m`} before kickoff{clv != null ? `, closing-line value ${c1(clv)}` : ""}</span>
        </span>
        <span className={`font-mono ${tone(x.pnl)}`}>{u(x.pnl)}</span>
      </li>
    );
  };

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-1 text-sm font-semibold text-foreground">How the game went</h3>
      <p className="mb-3 text-[11px] text-muted">Final: {result.away.abbr} {as}, {result.home.abbr} {hs}. How each main contract came out, and which closing price was nearest.</p>
      {rows.length > 0 && (
        <div className="mb-5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="text-left text-muted">
              <tr><th className="py-1 font-medium">Contract</th><th className="py-1 font-medium">Result</th><th className="py-1 text-right font-medium">DraftKings</th><th className="py-1 text-right font-medium">Exchange</th><th className="py-1 text-right font-medium">Kalshi</th><th className="py-1 text-right font-medium">Closest</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind} className="border-t border-border">
                  <td className="py-1.5 text-foreground">{label({ kind: r.kind, line: r.line }, game)}{r.kind !== "ml" && r.open != null && r.close != null && r.open !== r.close ? <span className="block text-[10px] text-muted">line opened {r.open}, closed {r.close}</span> : null}</td>
                  <td className="py-1.5 text-foreground">{r.text}</td>
                  <td className="py-1.5 text-right font-mono text-muted">{cents(r.dk)}</td>
                  <td className="py-1.5 text-right font-mono text-muted">{cents(r.x)}</td>
                  <td className="py-1.5 text-right font-mono text-muted">{cents(r.ks)}</td>
                  <td className={`py-1.5 text-right ${r.closer === "Exchange" ? "text-up" : "text-muted"}`}>{r.closer}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-muted">Closing prices are the chance of the home side, the home side covering, or the over. A difference under half a cent counts as level.</p>
        </div>
      )}

      <div className="mb-5 rounded-md border border-border p-3">
        <p className="mb-1 text-xs font-semibold text-foreground">Opening line and discovery</p>
        {d ? (
          <div className="space-y-1 text-[11px] leading-relaxed text-muted">
            <p>DraftKings had not priced this game, so the exchange made the line. It opened from the rating models at <span className="text-foreground">{d.seed ? `${homeBy(d.seed[0])}, total ${d.seed[1].toFixed(1)}` : "–"}</span>. By the time DraftKings posted, {d.hours_before.toFixed(0)} hours before kickoff and {d.rounds} rounds later, trading had moved it to <span className="text-foreground">{d.internal ? `${homeBy(d.internal[0])}, total ${d.internal[1].toFixed(1)}` : "–"}</span>, and DraftKings opened at <span className="text-foreground">{d.dk ? `${homeBy(d.dk[0])}, total ${d.dk[1].toFixed(1)}` : "–"}</span>.</p>
            {dSpread && dSpread.open != null && dSpread.then != null && dTotal && dTotal.open != null && dTotal.then != null && (
              <p>Off DraftKings by: spread {dSpread.open.toFixed(1)} at the opener, {dSpread.then.toFixed(1)} after trading ({cmp(dSpread.then, dSpread.open, "trading moved it toward DraftKings", "trading moved it away from DraftKings")}); total {dTotal.open.toFixed(1)} then {dTotal.then.toFixed(1)} ({cmp(dTotal.then, dTotal.open, "closer", "further")}).</p>
            )}
            {lastMk && <p>Then DraftKings&rsquo; line closed at spread {mainAt(lastMk, "spread") ?? "–"}, total {mainAt(lastMk, "total") ?? "–"}.</p>}
          </div>
        ) : (
          <div className="space-y-1 text-[11px] leading-relaxed text-muted">
            {firstMk && lastMk ? (
              <>
                <p>DraftKings opened (as the exchange first saw it) at spread <span className="text-foreground">{mainAt(firstMk, "spread") ?? "–"}</span>, total <span className="text-foreground">{mainAt(firstMk, "total") ?? "–"}</span>, and closed at spread <span className="text-foreground">{mainAt(lastMk, "spread") ?? "–"}</span>, total <span className="text-foreground">{mainAt(lastMk, "total") ?? "–"}</span>.</p>
                {mlAt(firstMk) != null && mlAt(lastMk) != null && <p>The {result.home.abbr} moneyline went from {cents(mlAt(firstMk))} to {cents(mlAt(lastMk))}.</p>}
              </>
            ) : (
              <p>No price history was kept for this game.</p>
            )}
          </div>
        )}
        {value.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold text-foreground">Who picked off value</p>
            <p className="mb-1 text-[10px] text-muted">The trades whose price beat the closing price by the most, counting size (units of closing-line value). It rewards the price, whatever the result was.</p>
            <ul>
              {value.map((x) => {
                const m = mem[x.t[x.side]];
                const buy = x.side === "buyer";
                const hrs = (kick - new Date(x.t.ts).getTime()) / 3600000;
                const before = d && new Date(x.t.ts).getTime() < new Date(d.found).getTime();
                return (
                  <li key={`${x.t.id}${x.side}v`} className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border py-1.5 text-[11px]">
                    <span className="min-w-0">
                      <Link href={`/syndicates/traders/${m.id}`} className="text-foreground hover:text-accent">{m.name}</Link>
                      <span className="ml-1 text-muted">({syn[m.syndicate_id]?.name}) {buy ? "bought" : "sold"} {label({ kind: x.t.kind, line: x.t.line }, game)} {Math.round(x.t.qty)} at {cents(x.t.price)}, closed {cents(x.t.close_p)}, {hrs >= 1 ? `${hrs.toFixed(0)}h` : `${Math.max(0, hrs * 60).toFixed(0)}m`} before kickoff{before ? ", before DraftKings posted" : ""}</span>
                    </span>
                    <span className="font-mono text-up">{u(x.v)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Where the money came from</p>
          <p className="mb-2 text-[10px] text-muted">Profit split by firm. Price is closing-line value (closing price against the price paid); result is how the game ended against the closing price. Units are cents per contract.</p>
          <table className="w-full text-xs">
            <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Firm</th><th className="py-1 text-right font-medium">Profit</th><th className="py-1 text-right font-medium">Price</th><th className="py-1 text-right font-medium">Result</th></tr></thead>
            <tbody className="font-mono">
              {shown.map(([sid, v]) => {
                const d = per[sid];
                return (
                  <tr key={sid} className="border-t border-border">
                    <td className="py-1 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: syn[sid]?.color }} />{syn[sid]?.name ?? sid}</td>
                    <td className={`py-1 text-right ${tone(v.pnl)}`}>{u(v.pnl)}</td>
                    <td className={`py-1 text-right ${d ? tone(d.clv / d.q) : "text-muted"}`}>{d ? c1(d.clv / d.q) : "–"}</td>
                    <td className={`py-1 text-right ${d ? tone(d.res / d.q) : "text-muted"}`}>{d ? c1(d.res / d.q) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Sharp, public and the rest</p>
          <p className="mb-2 text-[10px] text-muted">Total profit by kind of trader on this game. Sharp means a sharpness score of 50 or more in this sport today.</p>
          <table className="w-full text-xs">
            <tbody className="font-mono">
              {Object.entries(groups).sort((a, b) => b[1].pnl - a[1].pnl).map(([g, v]) => (
                <tr key={g} className="border-t border-border"><td className="py-1 font-sans text-foreground">{g}<span className="ml-2 text-[10px] text-muted">{v.n} traders</span></td><td className={`py-1 text-right ${tone(v.pnl)}`}>{u(v.pnl)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {single.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold text-foreground">Best single trades</p>
            <ul>{single.slice(0, 3).map(line)}</ul>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-foreground">Worst single trades</p>
            <ul>{single.slice(-3).reverse().map(line)}</ul>
          </div>
        </div>
      )}
      <p className="mt-3 text-[10px] text-muted">Single trades show profit if held to the end, before any netting against other trades.</p>
    </section>
  );
}
