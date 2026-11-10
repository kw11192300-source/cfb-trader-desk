import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getArbs, getExchange, getExchangeBoard, type ArbRec, type ExGame } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

// Kalshi vs DraftKings: where Kalshi's real-money price differs from DraftKings' no-vig price on the same contract. The Kalshi Followers firm trades exactly this gap, and on the exchange's record so far
// it is the one firm positive on results and on closing-line value (DraftKings moving its way) in four of five sports.

const SPORTS = ["cbb", "nba", "nhl", "cfb", "nfl"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const WINDOWS: [number, string][] = [[24, "24 hours"], [48, "2 days"], [72, "3 days"], [168, "7 days"], [336, "14 days"]];
const LINES: [string, string][] = [["main", "Main lines"], ["near", "Near the main line (within 2)"]];
const WIDTHS: [number, string][] = [[0.04, "4¢ or tighter"], [0.06, "6¢ or tighter"], [0.1, "10¢ or tighter"]];
const VOLS: [number, string][] = [[0, "Any"], [100, "100+"], [500, "500+"]];
const MIN_GAP = 2; // cents: rows at or above this are all shown; with fewer than FLOOR_N the biggest few are shown anyway
const FLOOR_N = 5;
const CAP = 60;

type Params = { sport?: string; h?: string; lines?: string; w?: string; v?: string };

const leans = (g: ExGame, kind: string, line: number, gap: number) => {
  const yes = gap > 0;
  if (kind === "ml") return `${yes ? g.home.abbr : g.away.abbr} to win`;
  if (kind === "spread") return yes ? `${g.home.abbr} ${line > 0 ? "+" : ""}${line}` : `${g.away.abbr} ${-line > 0 ? "+" : ""}${-line}`;
  return `${yes ? "Over" : "Under"} ${line}`;
};

export default async function KalshiPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const hours = WINDOWS.find(([h]) => String(h) === sp.h)?.[0] ?? 72;
  const lineMode = LINES.find(([k]) => k === sp.lines)?.[0] ?? "main";
  const maxW = WIDTHS.find(([w]) => String(w) === sp.w)?.[0] ?? 0.06;
  const minVol = VOLS.find(([v]) => String(v) === sp.v)?.[0] ?? 0;
  const [board, { meta }, arbLog] = await Promise.all([getExchangeBoard(hours), getExchange(), getArbs()]);
  const inScope = board.filter((g) => (!sport || g.sport === sport) && new Date(g.start_utc).getTime() > Date.now() && (g.ref?.src ?? "dk") === "dk");

  const q = (o: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { sport: sport ?? undefined, h: hours === 72 ? undefined : String(hours), lines: lineMode === "main" ? undefined : lineMode, w: maxW === 0.06 ? undefined : String(maxW), v: minVol === 0 ? undefined : String(minVol), ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/kalshi${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  type Row = { g: ExGame; kind: string; line: number; dk: number; ks: number; bid: number | null; ask: number | null; vol: number; gap: number; width: number | null; x: number | null };
  const rows: Row[] = [];
  let withKalshi = 0;
  for (const g of inScope) {
    const kal = g.views?.kal ?? [];
    if (kal.length) withKalshi += 1;
    const book = new Map((g.book ?? []).map((b) => [`${b[0]}|${b[1]}`, b]));
    for (const [kind, line, mid, bid, ask, vol] of kal) {
      const b = book.get(`${kind}|${line}`);
      if (!b || b[2] == null || mid == null) continue;
      const width = bid != null && ask != null ? ask - bid : null;
      if (width != null && width > maxW + 1e-9) continue; // a wide Kalshi quote is not a price
      if (vol < minVol) continue;
      const main = g.ref?.[kind === "spread" ? "spread" : "total"];
      if (kind !== "ml") {
        if (main == null) continue;
        const off = Math.abs(line - main);
        if (lineMode === "main" && off > 0.5 + 1e-9) continue;
        if (lineMode === "near" && off > 2 + 1e-9) continue;
      }
      rows.push({ g, kind, line, dk: b[2], ks: mid, bid: bid ?? null, ask: ask ?? null, vol, gap: (mid - b[2]) * 100, width, x: b[9] });
    }
  }
  // Arbitrage check: DraftKings' actual price (vig included, what someone would really bet) on one side against the opposite side on Kalshi bought at its ask. Cost under $1 locks in a profit. Kalshi fees are not counted.
  type Arb = { g: ExGame; kind: string; line: number; dkLabel: string; dkAm: number; dkP: number; kLabel: string; kP: number; cost: number; vol: number; width: number; size: number | null };
  const arbs: Arb[] = [];
  const impl = (a: number) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
  const american = (p: number) => (p < 0.5 ? Math.round((100 * (1 - p)) / p) : Math.round((-100 * p) / (1 - p)));
  const am = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  for (const g of inScope) {
    const ref = g.ref;
    if (!ref) continue;
    const h = g.home.abbr, a = g.away.abbr;
    for (const [kind, line, , bid, ask, vol, bidSize, askSize] of g.views?.kal ?? []) {
      if (bid == null || ask == null) continue;
      let dh: number | null | undefined, da: number | null | undefined, lh: string, la: string;
      if (kind === "ml") { dh = ref.ml_home; da = ref.ml_away; lh = `${h} to win`; la = `${a} to win`; }
      else if (kind === "spread") {
        if (ref.spread == null || Math.abs(line - ref.spread) > 1e-6) continue;
        dh = ref.spread_home; da = ref.spread_away; lh = `${h} ${line > 0 ? "+" : ""}${line}`; la = `${a} ${-line > 0 ? "+" : ""}${-line}`;
      } else {
        if (ref.total == null || Math.abs(line - ref.total) > 1e-6) continue;
        dh = ref.over; da = ref.under; lh = `Over ${line}`; la = `Under ${line}`;
      }
      if (dh == null || da == null) continue;
      const ph = impl(dh), pa = impl(da);
      if (ph + pa < 1.01 || ph + pa > 1.12) continue; // a stale or one-sided DraftKings price is not a real quote
      // Side A: DraftKings home/over plus Kalshi's other side (cost 1 - bid). Side B: DraftKings away/under plus Kalshi yes at the ask.
      arbs.push({ g, kind, line, dkLabel: lh, dkAm: dh, dkP: ph, kLabel: la, kP: 1 - bid, cost: ph + 1 - bid, vol, width: ask - bid, size: bidSize ?? null });
      arbs.push({ g, kind, line, dkLabel: la, dkAm: da, dkP: pa, kLabel: lh, kP: ask, cost: pa + ask, vol, width: ask - bid, size: askSize ?? null });
    }
  }
  arbs.sort((x, y) => x.cost - y.cost);
  const liveArbs = arbs.filter((r) => r.cost < 1 - 1e-9);
  const arbShown = liveArbs.length ? liveArbs.slice(0, 15) : arbs.slice(0, 8);

  rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const strong = rows.filter((r) => Math.abs(r.gap) >= MIN_GAP);
  const fallback = strong.length < FLOOR_N;
  const shown = fallback ? rows.slice(0, FLOOR_N) : strong.slice(0, CAP);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="kalshi" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Kalshi vs DraftKings: where the two prices disagree</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Kalshi is a real-money exchange; this compares the middle of its bid and ask with DraftKings&rsquo; no-vig price on the same contract. The firm that trades this gap, Kalshi Followers, has the best record on the exchange so far:
          positive on results and on closing-line value (DraftKings moving toward its side) in four of five sports, with a small sample and wide error bars, so treat a gap as a lead to check, not a signal. Rows at {MIN_GAP}¢ or more are all shown; with fewer than {FLOOR_N}{" "}
          the {FLOOR_N} biggest are shown anyway. A wide Kalshi quote is not a price, so quotes wider than the limit below are left out, and thin volume is flagged.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Starts within</span>
            {WINDOWS.map(([h, name]) => <Link key={h} href={q({ h: h === 72 ? undefined : String(h) })} className={chip(hours === h)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Lines</span>
            {LINES.map(([k, name]) => <Link key={k} href={q({ lines: k === "main" ? undefined : k })} className={chip(lineMode === k)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Kalshi quote</span>
            {WIDTHS.map(([w, name]) => <Link key={w} href={q({ w: w === 0.06 ? undefined : String(w) })} className={chip(maxW === w)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Kalshi volume</span>
            {VOLS.map(([v, name]) => <Link key={v} href={q({ v: v === 0 ? undefined : String(v) })} className={chip(minVol === v)}>{name}</Link>)}
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Games with a DraftKings line", String(inScope.length)],
            ["With Kalshi prices", String(withKalshi)],
            ["Lines compared", String(rows.length)],
            [`At ${MIN_GAP}¢ or more`, String(strong.length)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
          ))}
        </div>

        <section className="mb-6">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Arbitrage check{liveArbs.length ? `: ${liveArbs.length} open` : ": none open"}</h3>
          <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
            A bet at DraftKings&rsquo; real price (vig included) paired with the opposite side bought on Kalshi at its ask, same line. If the two costs add to less than 100¢ the profit is locked in whatever happens. Kalshi fees are not included, and
            DraftKings prices come from ESPN, which can lag, so confirm both prices before acting. Available is how many contracts are waiting on Kalshi at the best price; DraftKings&rsquo; own limit is not known. Sizes show a dash until the next engine round after this change goes out.
            {liveArbs.length === 0 ? " Nothing is under 100¢ right now, so these are the closest." : ""}
          </p>
          {arbShown.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-4 py-4 text-center text-xs text-muted">No comparable lines at this sport and time setting.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2">Bet at DraftKings</th>
                    <th className="px-3 py-2">Bet at Kalshi</th>
                    <th className="px-3 py-2 text-right">Total cost</th>
                    <th className="px-3 py-2 text-right">Locked profit</th>
                    <th className="px-3 py-2 text-right" title="Contracts waiting on Kalshi at that price, each paying $1, and the profit locked in if all of them were taken">Kalshi available</th>
                    <th className="px-3 py-2 text-right">Kalshi volume</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {arbShown.map((r, i) => {
                    const edge = (1 / r.cost - 1) * 100;
                    return (
                      <tr key={`${r.g.id}${r.kind}${r.line}${i}`} className="border-t border-border align-top">
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <span className="mr-1.5 text-[10px] text-muted">{SPORT[r.g.sport]}</span>
                          <Link href={`/syndicates/games/${encodeURIComponent(r.g.id)}`} className="hover:text-accent">{r.g.away.abbr} @ {r.g.home.abbr}</Link>
                          <div className="text-[10px] text-muted"><LocalDateTime iso={r.g.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></div>
                        </td>
                        <td className="px-3 py-1.5 font-sans text-foreground">{r.dkLabel} <span className="font-mono text-muted">{am(r.dkAm)}</span></td>
                        <td className="px-3 py-1.5 font-sans text-foreground">{r.kLabel} <span className="font-mono text-muted">{(r.kP * 100).toFixed(0)}¢ ({am(american(r.kP))})</span></td>
                        <td className={`px-3 py-1.5 text-right ${r.cost < 1 ? "font-semibold text-accent" : "text-foreground"}`}>{(r.cost * 100).toFixed(1)}¢</td>
                        <td className={`px-3 py-1.5 text-right ${edge > 0 ? "font-semibold text-accent" : "text-muted"}`}>{edge > 0 ? "+" : ""}{edge.toFixed(2)}%</td>
                        <td className={`px-3 py-1.5 text-right ${r.size == null ? "text-muted" : r.size < 20 ? "text-down" : "text-foreground"}`}>
                          {r.size == null ? "–" : `${Math.floor(r.size).toLocaleString()} ${Math.floor(r.size) === 1 ? "contract" : "contracts"}`}
                          {r.size != null && r.cost < 1 && <div className="text-[10px] text-muted">${(Math.floor(r.size) * (1 - r.cost)).toFixed(2)} locked</div>}
                        </td>
                        <td className={`px-3 py-1.5 text-right ${r.vol < 100 ? "text-muted" : "text-foreground"}`}>{Math.round(r.vol).toLocaleString()}{r.vol < 100 ? " (thin)" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {(() => {
          // the arbitrage log: every arb from the round it appeared to the round it closed, so the record shows how often they come, how big, how long they last and what is left after Kalshi's fee
          const all: ArbRec[] = [...arbLog.open, ...arbLog.closed].filter((r) => !sport || r.sport === sport);
          const mins = (r: ArbRec) => Math.max(0, Math.round((new Date(r.last).getTime() - new Date(r.first).getTime()) / 60000));
          const sz = (r: ArbRec) => Math.floor(r.best_size ?? 0);
          const done = all.filter((r) => r.closed);
          const lasted = done.map(mins).sort((a, b) => a - b);
          const median = lasted.length ? lasted[Math.floor(lasted.length / 2)] : null;
          const graded = all.filter((r) => r.res != null);
          const wins = graded.filter((r) => r.res === 1).length, losses = graded.filter((r) => r.res === 0).length, pushes = graded.length - wins - losses;
          const units = graded.reduce((a, r) => a + (r.pnl ?? 0), 0);
          const withClv = graded.filter((r) => r.clv != null);
          const avgClv = withClv.length ? (withClv.reduce((a, r) => a + (r.clv ?? 0), 0) / withClv.length) * 100 : null;
          const beat = withClv.length ? withClv.filter((r) => (r.clv ?? 0) > 0).length / withClv.length : null;
          const pending = done.length - graded.length;
          const openNow = arbLog.open.filter((r) => !sport || r.sport === sport);
          const recent = [...openNow, ...[...done].sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? ""))].slice(0, 25);
          return (
            <section className="mb-6">
              <h3 className="mb-1 text-sm font-semibold text-foreground">Arbitrage history</h3>
              <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
                Logged every exchange round (about every five minutes) since {arbLog.since ? <LocalDateTime iso={arbLog.since} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> : "the log started"}, {arbLog.rounds.toLocaleString()} rounds so far.
                An arb is logged from the round it first appears to the round it is gone, with its best price and the contracts waiting on Kalshi at that price. One that came and went inside a single round is never seen, so lifetimes are good to about one round.
                &ldquo;After fee&rdquo; takes off Kalshi&rsquo;s taker fee, about 7% x price x (1 - price) per contract.
              </p>
              <div className="mb-3 grid grid-cols-3 gap-3">
                {[
                  ["Arbs seen", String(all.length)],
                  ["Open now", String(openNow.length)],
                  ["Typical life", median == null ? "–" : median === 0 ? "under a round" : `${median} min`],
                ].map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-base font-semibold text-foreground">{v}</p></div>)}
              </div>
              <p className="mb-1 text-[11px] font-medium text-foreground">Betting just the DraftKings side of each one (one unit at the price it first had, no Kalshi hedge)</p>
              <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
                An arb means Kalshi prices the other side low enough that the DraftKings side is worth more than DraftKings charges. This is the record of simply taking that side, graded when the game is final. Closing-line value is how far
                DraftKings&rsquo; own no-vig price on that side moved toward it by the close (only where the line did not move). {pending > 0 ? `${pending} not graded yet.` : ""}
              </p>
              <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  ["Graded", String(graded.length)],
                  ["Record", graded.length ? `${wins}-${losses}${pushes ? `-${pushes}` : ""}` : "–"],
                  ["Units", graded.length ? `${units >= 0 ? "+" : ""}${units.toFixed(2)}` : "–"],
                  ["ROI", graded.length ? `${units >= 0 ? "+" : ""}${((units / graded.length) * 100).toFixed(1)}%` : "–"],
                  ["Avg closing value", avgClv == null ? "–" : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}¢${beat != null ? ` (${(beat * 100).toFixed(0)}% better)` : ""}`],
                ].map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-base font-semibold text-foreground">{v}</p></div>)}
              </div>
              {recent.length === 0 ? (
                <p className="rounded-lg border border-border bg-surface px-4 py-4 text-center text-xs text-muted">No arbs logged yet at this setting. The log fills in as rounds run.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[980px] text-xs">
                    <thead className="bg-surface text-left text-muted">
                      <tr>
                        <th className="px-3 py-2">Game</th><th className="px-3 py-2">DraftKings</th><th className="px-3 py-2">Kalshi</th>
                        <th className="px-3 py-2 text-right">Best cost</th><th className="px-3 py-2 text-right">Edge</th><th className="px-3 py-2 text-right">After fee</th>
                        <th className="px-3 py-2 text-right">Best size</th><th className="px-3 py-2">First seen</th><th className="px-3 py-2 text-right">Lasted</th><th className="px-3 py-2">Ended</th><th className="px-3 py-2 text-right" title="One unit on the DraftKings side at its price when first seen">DK bet</th><th className="px-3 py-2 text-right" title="How far DraftKings' no-vig price on that side moved toward it by the close">Close value</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {recent.map((r) => {
                        const edge = (1 / r.best_cost - 1) * 100, edgeNet = (1 / (r.best_cost + r.best_fee) - 1) * 100;
                        return (
                          <tr key={`${r.key}${r.first}`} className="border-t border-border align-top">
                            <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-1.5 text-[10px] text-muted">{SPORT[r.sport]}</span>{r.teams}</td>
                            <td className="px-3 py-1.5 font-sans text-foreground">{r.dk_label} <span className="font-mono text-muted">{r.dk_am > 0 ? "+" : ""}{r.dk_am}</span></td>
                            <td className="px-3 py-1.5 font-sans text-foreground">{r.k_label} <span className="font-mono text-muted">{(r.kp * 100).toFixed(0)}¢</span></td>
                            <td className="px-3 py-1.5 text-right">{(r.best_cost * 100).toFixed(1)}¢</td>
                            <td className="px-3 py-1.5 text-right text-accent">+{edge.toFixed(2)}%</td>
                            <td className={`px-3 py-1.5 text-right ${edgeNet > 0 ? "text-accent" : "text-muted"}`}>{edgeNet > 0 ? "+" : ""}{edgeNet.toFixed(2)}%</td>
                            <td className={`px-3 py-1.5 text-right ${sz(r) < 20 ? "text-down" : "text-foreground"}`}>{r.best_size == null ? "–" : sz(r)}</td>
                            <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={r.first} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                            <td className="px-3 py-1.5 text-right text-muted">{r.closed ? (mins(r) === 0 ? "< 1 round" : `${mins(r)} min`) : <span className="text-up">open, {mins(r)} min</span>}</td>
                            <td className="px-3 py-1.5 font-sans text-muted">{r.closed ? r.why : "still open"}</td>
                            <td className={`px-3 py-1.5 text-right ${r.res == null ? "text-muted" : (r.pnl ?? 0) > 0 ? "text-up" : (r.pnl ?? 0) < 0 ? "text-down" : "text-muted"}`}>{r.res == null ? (r.closed ? "pending" : "open") : r.res === 0.5 ? "push" : `${r.res === 1 ? "won" : "lost"} ${(r.pnl ?? 0) > 0 ? "+" : ""}${(r.pnl ?? 0).toFixed(2)}`}</td>
                            <td className={`px-3 py-1.5 text-right ${r.clv == null ? "text-muted" : r.clv > 0 ? "text-up" : r.clv < 0 ? "text-down" : "text-muted"}`}>{r.clv == null ? "–" : `${r.clv > 0 ? "+" : ""}${(r.clv * 100).toFixed(1)}¢`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })()}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No lines to compare at this setting. Kalshi lists far fewer college basketball and NHL games than football, so try a longer window or looser limits.</p>
        ) : (
          <>
            {fallback && <p className="mb-2 rounded border border-border bg-surface px-3 py-2 text-[11px] text-muted">Nothing is {MIN_GAP}¢ or more apart at this setting, so these are the {shown.length} biggest.</p>}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2">Kalshi leans to</th>
                    <th className="px-3 py-2 text-right">DraftKings</th>
                    <th className="px-3 py-2 text-right">Kalshi</th>
                    <th className="px-3 py-2 text-right">Gap</th>
                    <th className="px-3 py-2 text-right" title="Kalshi's best bid and ask">Kalshi bid / ask</th>
                    <th className="px-3 py-2 text-right" title="Contracts traded on Kalshi">Volume</th>
                    <th className="px-3 py-2 text-right" title="This exchange's own price for the same contract">Exchange</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {shown.map((r) => (
                    <tr key={`${r.g.id}${r.kind}${r.line}`} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <span className="mr-1.5 text-[10px] text-muted">{SPORT[r.g.sport]}</span>
                        <Link href={`/syndicates/games/${encodeURIComponent(r.g.id)}`} className="hover:text-accent">{r.g.away.abbr} @ {r.g.home.abbr}</Link>
                        <div className="text-[10px] text-muted"><LocalDateTime iso={r.g.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></div>
                      </td>
                      <td className="px-3 py-1.5 font-sans font-medium text-accent">{leans(r.g, r.kind, r.line, r.gap)}</td>
                      <td className="px-3 py-1.5 text-right">{(r.dk * 100).toFixed(1)}¢</td>
                      <td className="px-3 py-1.5 text-right">{(r.ks * 100).toFixed(1)}¢</td>
                      <td className={`px-3 py-1.5 text-right font-semibold ${Math.abs(r.gap) >= MIN_GAP ? "text-accent" : "text-foreground"}`}>{r.gap > 0 ? "+" : ""}{r.gap.toFixed(1)}¢</td>
                      <td className="px-3 py-1.5 text-right text-muted">{r.bid != null && r.ask != null ? `${(r.bid * 100).toFixed(0)}¢ / ${(r.ask * 100).toFixed(0)}¢` : "–"}</td>
                      <td className={`px-3 py-1.5 text-right ${r.vol < 100 ? "text-muted" : "text-foreground"}`}>{Math.round(r.vol).toLocaleString()}{r.vol < 100 ? " (thin)" : ""}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{r.x != null ? `${(r.x * 100).toFixed(1)}¢` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!fallback && strong.length > CAP && <p className="mt-2 text-[11px] text-muted">Showing the top {CAP} of {strong.length}. Narrow by sport or time to see the rest.</p>}
          </>
        )}
      </main>
    </div>
  );
}
