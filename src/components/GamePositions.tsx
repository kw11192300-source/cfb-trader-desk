import Link from "next/link";

import { bandsFor } from "@/lib/positions";
import { lotPnl } from "@/lib/syndicateGame";
import { type ExGame, fairOf, label, type Lot, pct } from "@/lib/syndicates";

export type SynInfo = { id: string; name: string; color: string; engine: string };
type Dim = "m" | "t";

const SD: Record<string, { m: number; t: number }> = { nfl: { m: 13.2, t: 13.5 }, cfb: { m: 14, t: 17 }, nba: { m: 12.9, t: 18 }, cbb: { m: 11.3, t: 16.8 }, nhl: { m: 2.3, t: 2.4 } };
const SPAN: Record<string, { m: number; t: number }> = { nfl: { m: 30, t: 25 }, cfb: { m: 35, t: 30 }, nba: { m: 30, t: 45 }, cbb: { m: 30, t: 40 }, nhl: { m: 6, t: 4 } };
const u = (n: number, d = 0) => `${n > 0.05 ? "+" : ""}${n.toFixed(d)}`;
const tone = (n: number) => (n > 0.5 ? "text-up" : n < -0.5 ? "text-down" : "text-muted");

/** What kind of firm a syndicate is, for colouring the picture by who is trading rather than by name. */
const TYPES: Record<string, { name: string; color: string }> = {
  public: { name: "Public money", color: "#f97316" },
  maker: { name: "Market makers", color: "#14b8a6" },
  lab: { name: "Research labs", color: "#e879f9" },
  kalshi: { name: "Kalshi followers", color: "#10b981" },
  model: { name: "Model syndicates", color: "#3b82f6" },
};
const typeOf = (engine: string) => (engine === "public" ? "public" : engine === "mm" || engine === "ref" ? "maker" : engine === "agent" ? "lab" : engine === "kalshi" ? "kalshi" : "model");

function pdf(x: number, mu: number, sd: number) {
  return Math.exp(-0.5 * ((x - mu) / sd) ** 2);
}

function xsFor(g: ExGame, dim: Dim): number[] {
  const span = SPAN[g.sport] ?? SPAN.nba;
  const lo = dim === "m" ? -span.m : Math.round((g.ref?.total ?? 0) - span.t);
  const hi = dim === "m" ? span.m : Math.round((g.ref?.total ?? 0) + span.t);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const TOP = 6;

function Payoff({ game, lots, dim, colorOf, nameOf, showAll }: { game: ExGame; lots: Lot[]; dim: Dim; colorOf: (o: string) => string; nameOf: (o: string) => string; showAll: boolean }) {
  const ls = lots.filter((l) => (dim === "t") === (l.kind === "total"));
  const owners = [...new Set(ls.map((l) => l.owner))];
  if (!owners.length) return <p className="rounded-lg border border-border bg-surface px-3 py-8 text-center text-xs text-muted">Nobody holds a {dim === "m" ? "side or spread" : "total"} position on this game.</p>;
  const full = xsFor(game, dim);
  const sd0 = SD[game.sport] ?? SD.nba;
  const mu0 = dim === "m" ? (game.ref?.spread != null ? -game.ref.spread : 0) : game.ref?.total ?? full[Math.floor(full.length / 2)];
  const sgm = dim === "m" ? sd0.m : sd0.t;
  const cutsAll = ls.flatMap((l) => (dim === "t" ? [l.line] : [-l.line]));
  const dLo = Math.floor(Math.min(mu0 - 2.2 * sgm, Math.min(...cutsAll) - 4)), dHi = Math.ceil(Math.max(mu0 + 2.2 * sgm, Math.max(...cutsAll) + 4));
  const xs = full.filter((v) => v >= dLo && v <= dHi);
  const ys: Record<string, number[]> = Object.fromEntries(owners.map((o) => [o, xs.map((x) => ls.filter((l) => l.owner === o).reduce((a, l) => a + lotPnl(l, dim === "m" ? x : 0, dim === "t" ? x : 0), 0))]));
  const all = Object.values(ys).flat();
  let y0 = Math.min(0, ...all), y1 = Math.max(0, ...all);
  const padY = (y1 - y0) * 0.1 || 1;
  y0 -= padY; y1 += padY;
  const W = 760, H = 300, L = 46, R = 12, T = 12, B = 36;
  const sd = SD[game.sport] ?? SD.nba;
  const mu = dim === "m" ? (game.ref?.spread != null ? -game.ref.spread : 0) : game.ref?.total ?? xs[Math.floor(xs.length / 2)];
  const s = dim === "m" ? sd.m : sd.t;
  const x = (v: number) => L + ((v - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - L - R);
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const base = H - B;
  const dens = xs.map((v) => pdf(v, mu, s));
  const dpath = `M${x(xs[0])},${base} ` + xs.map((v, i) => `L${x(v).toFixed(1)},${(base - dens[i] * 70).toFixed(1)}`).join(" ") + ` L${x(xs[xs.length - 1])},${base} Z`;
  const xt = niceTicks(xs[0], xs[xs.length - 1], 8);
  const yt = niceTicks(y0, y1, 5);
  const ranked = owners.map((o) => ({ o, lo: Math.min(...ys[o]), hi: Math.max(...ys[o]) })).sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  const shown = new Set(showAll ? owners : ranked.slice(0, TOP).map((r) => r.o));
  return (
    <div>
      <style>{".pm:hover .pl:not(:hover){opacity:.15}.pl{transition:opacity .12s}"}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="pm w-full" role="img" aria-label="Profit or loss by final result, one line per syndicate">
        {yt.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={0.5} />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" className="fill-muted" fontSize={9}>{u(v)}</text>
          </g>
        ))}
        <path d={dpath} className="fill-accent/10" />
        <line x1={x(mu)} x2={x(mu)} y1={T} y2={base} className="stroke-muted" strokeWidth={0.8} strokeDasharray="3 3" />
        <text x={x(mu) + 4} y={T + 9} className="fill-muted" fontSize={9}>DraftKings expects {dim === "m" ? `${game.home.abbr} ${mu > 0 ? "+" : ""}${mu.toFixed(1)}` : mu.toFixed(1)}</text>
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="stroke-muted" strokeWidth={1} />
        {xt.map((v) => (
          <text key={v} x={x(v)} y={H - 10} textAnchor="middle" className="fill-muted" fontSize={9}>{dim === "m" && v > 0 ? `+${v}` : v}</text>
        ))}
        <text x={W / 2} y={H - 0.5} textAnchor="middle" className="fill-muted" fontSize={9}>{dim === "m" ? `final margin (${game.home.abbr} minus ${game.away.abbr}); shaded: how likely each result is` : "combined points; shaded: how likely each total is"}</text>
        {[...owners.filter((o) => !shown.has(o)), ...owners.filter((o) => shown.has(o))].map((o) => (
          <g key={o} className="pl">
            <polyline fill="none" stroke={shown.has(o) ? colorOf(o) : "#888780"} opacity={shown.has(o) ? 1 : 0.35} strokeWidth={shown.has(o) ? 2 : 1} strokeLinejoin="round" points={xs.map((v, i) => `${x(v).toFixed(1)},${y(ys[o][i]).toFixed(1)}`).join(" ")}>
              <title>{`${nameOf(o)}: worst ${u(Math.min(...ys[o]))}, best ${u(Math.max(...ys[o]))}`}</title>
            </polyline>
            <polyline fill="none" stroke="transparent" strokeWidth={9} points={xs.map((v, i) => `${x(v).toFixed(1)},${y(ys[o][i]).toFixed(1)}`).join(" ")}>
              <title>{`${nameOf(o)}: worst ${u(Math.min(...ys[o]))}, best ${u(Math.max(...ys[o]))}`}</title>
            </polyline>
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {ranked.filter(({ o }) => shown.has(o)).map(({ o, lo, hi }) => (
          <span key={o}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: colorOf(o) }} />{nameOf(o)} <span className="font-mono text-down">{u(lo)}</span> / <span className="font-mono text-up">{u(hi)}</span></span>
        ))}
        {!showAll && owners.length > TOP && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-muted/50" />{owners.length - TOP} smaller books in gray</span>}
      </div>
    </div>
  );
}

function Ladder({ game, lots, dim, colorOf, nameOf }: { game: ExGame; lots: Lot[]; dim: Dim; colorOf: (o: string) => string; nameOf: (o: string) => string }) {
  const ls = lots.filter((l) => (dim === "t") === (l.kind === "total"));
  const keys = [...new Set(ls.map((l) => `${l.kind}|${l.line}`))].map((k) => ({ kind: k.split("|")[0] as Lot["kind"], line: Number(k.split("|")[1]) })).sort((a, b) => (a.kind === b.kind ? a.line - b.line : a.kind === "ml" ? -1 : 1));
  if (!keys.length) return null;
  const rows = keys.map((k) => {
    const net: Record<string, number> = {};
    for (const l of ls) if (l.kind === k.kind && l.line === k.line) net[l.owner] = (net[l.owner] ?? 0) + l.qty;
    const pos = Object.entries(net).filter(([, q]) => q > 0.3).sort((a, b) => b[1] - a[1]);
    const neg = Object.entries(net).filter(([, q]) => q < -0.3).sort((a, b) => a[1] - b[1]);
    return { ...k, pos, neg, long: pos.reduce((a, [, q]) => a + q, 0), short: neg.reduce((a, [, q]) => a - q, 0) };
  });
  const max = Math.max(1, ...rows.flatMap((r) => [r.long, r.short]));
  const lt = dim === "t" ? "Under" : game.away.abbr, rt = dim === "t" ? "Over" : game.home.abbr;
  return (
    <div>
      <div className="mb-1 grid grid-cols-[minmax(0,1fr)_132px_minmax(0,1fr)] items-center gap-2 text-[10px] uppercase tracking-wide text-muted">
        <span className="text-right">backs {lt}</span><span className="text-center">line · DK price</span><span>backs {rt}</span>
      </div>
      <div className="space-y-px">
        {rows.map((r) => (
          <div key={`${r.kind}${r.line}`} className="grid grid-cols-[minmax(0,1fr)_132px_minmax(0,1fr)] items-center gap-2 py-[2px] text-[11px]">
            <div className="flex items-center justify-end gap-2">
              <span className="font-mono text-[10px] text-muted">{r.short > 0.3 ? r.short.toFixed(0) : ""}</span>
              <div className="flex h-3.5 flex-row-reverse" style={{ width: `${(r.short / max) * 80}%` }}>
                {r.neg.map(([o, q]) => <div key={o} style={{ width: `${(-q / r.short) * 100}%`, background: colorOf(o) }} title={`${nameOf(o)}: ${(-q).toFixed(0)} backing ${lt}`} className="h-full border-l border-background first:border-l-0" />)}
              </div>
            </div>
            <span className="text-center font-mono text-foreground" title={label(r, game)}>{label(r, game).replace(`${game.home.abbr} `, "").replace(" to win", "")} <span className="text-muted">· {pct(fairOf(game, r.kind, r.line))}</span></span>
            <div className="flex items-center gap-2">
              <div className="flex h-3.5" style={{ width: `${(r.long / max) * 80}%` }}>
                {r.pos.map(([o, q]) => <div key={o} style={{ width: `${(q / r.long) * 100}%`, background: colorOf(o) }} title={`${nameOf(o)}: ${q.toFixed(0)} backing ${rt}`} className="h-full border-l border-background first:border-l-0" />)}
              </div>
              <span className="font-mono text-[10px] text-muted">{r.long > 0.3 ? r.long.toFixed(0) : ""}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Heat({ game, lots, dim, colorOf, nameOf }: { game: ExGame; lots: Lot[]; dim: Dim; colorOf: (o: string) => string; nameOf: (o: string) => string }) {
  const ls = lots.filter((l) => (dim === "t") === (l.kind === "total"));
  const owners = [...new Set(ls.map((l) => l.owner))];
  const bands = bandsFor(ls, game, dim);
  if (!owners.length || !bands.length) return null;
  const per = owners.map((o) => ({ o, bands: bandsFor(ls.filter((l) => l.owner === o), game, dim, ls) }));
  const rows = per.map(({ o, bands: b }) => ({ o, b, lo: Math.min(...b.map((x) => x.pnl)), hi: Math.max(...b.map((x) => x.pnl)), exp: b.reduce((a, x) => a + (x.chance ?? 0) * x.pnl, 0) })).sort((a, b) => a.lo - b.lo);
  const max = Math.max(1, ...rows.flatMap((r) => r.b.map((x) => Math.abs(x.pnl))));
  const shade = (v: number) => (Math.abs(v) < 0.05 ? undefined : { background: `${v > 0 ? "rgba(34,197,94," : "rgba(239,68,68,"}${(0.12 + 0.5 * Math.min(1, Math.abs(v) / max)).toFixed(2)})` });
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[11px]">
        <thead className="bg-surface text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Syndicate</th>
            {bands.map((b, i) => <th key={i} className="px-2 py-2 text-center align-bottom font-medium leading-tight" style={{ minWidth: 82 }}>{b.label}<span className="block font-mono text-[10px] font-normal">{b.chance == null ? "" : `${(b.chance * 100).toFixed(0)}%`}</span></th>)}
            <th className="border-l border-border px-2 py-2 text-right font-medium">Worst</th>
            <th className="px-2 py-2 text-right font-medium">Best</th>
            <th className="px-2 py-2 text-right font-medium" title="Each result's P&L weighted by its chance (DraftKings' price)">Expected</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.o} className="border-t border-border">
              <td className="whitespace-nowrap px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: colorOf(r.o) }} />{nameOf(r.o)}</td>
              {r.b.map((x, i) => <td key={i} style={shade(x.pnl)} className={`px-2 py-1.5 text-center ${tone(x.pnl)}`}>{Math.abs(x.pnl) < 0.05 ? "·" : u(x.pnl)}</td>)}
              <td className={`border-l border-border px-2 py-1.5 text-right ${tone(r.lo)}`}>{u(r.lo)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(r.hi)}`}>{u(r.hi)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(r.exp)}`}>{u(r.exp, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The game page's picture of every syndicate's book: who wins and loses at each result, who is on which side of each line, and a grid of both. */
export function GamePositions({ game, lots, syns, dim, colorBy, showAll, hrefFor }: { game: ExGame; lots: Lot[]; syns: SynInfo[]; dim: Dim; colorBy: "syn" | "type"; showAll: boolean; hrefFor: (o: { pv?: Dim; col?: "syn" | "type"; all?: boolean }) => string }) {
  const info = Object.fromEntries(syns.map((s) => [s.id, s]));
  const colorOf = (o: string) => (colorBy === "type" ? TYPES[typeOf(info[o]?.engine ?? "")].color : info[o]?.color ?? "#888");
  const nameOf = (o: string) => info[o]?.name ?? o;
  const present = [...new Set(lots.map((l) => typeOf(info[l.owner]?.engine ?? "")))];
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Position map: who holds what, and who wins if it ends like this</h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <div className="flex gap-1">
            <Link href={hrefFor({ pv: "m" })} scroll={false} className={chip(dim === "m")}>Game result</Link>
            <Link href={hrefFor({ pv: "t" })} scroll={false} className={chip(dim === "t")}>Combined score</Link>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">Lines</span>
            <Link href={hrefFor({ all: false })} scroll={false} className={chip(!showAll)}>Biggest {TOP}</Link>
            <Link href={hrefFor({ all: true })} scroll={false} className={chip(showAll)}>All</Link>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">Color by</span>
            <Link href={hrefFor({ col: "syn" })} scroll={false} className={chip(colorBy === "syn")}>Syndicate</Link>
            <Link href={hrefFor({ col: "type" })} scroll={false} className={chip(colorBy === "type")}>Type of firm</Link>
          </div>
        </div>
      </div>
      {colorBy === "type" && (
        <p className="mb-2 flex flex-wrap gap-x-4 text-[11px] text-muted">
          {present.map((t) => <span key={t}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: TYPES[t].color }} />{TYPES[t].name}</span>)}
        </p>
      )}
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
        {dim === "m" ? "Side and spread bets only; totals are on the other tab." : "Total bets only; side and spread bets are on the other tab."} The chart shows what each syndicate makes or loses at every final result,
        with the shaded hill showing how likely each result is by DraftKings&rsquo; price. Below it, each bar is a line on this game: how many contracts back each side, split by who holds them. The grid at the bottom reads the same books at the results that matter for the lines actually held.
      </p>
      <Payoff game={game} lots={lots} dim={dim} colorOf={colorOf} nameOf={nameOf} showAll={showAll} />
      <div className="mt-6"><Ladder game={game} lots={lots} dim={dim} colorOf={colorOf} nameOf={nameOf} /></div>
      <div className="mt-6"><Heat game={game} lots={lots} dim={dim} colorOf={colorOf} nameOf={nameOf} /></div>
    </section>
  );
}
