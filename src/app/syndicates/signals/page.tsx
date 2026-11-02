import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getSignalGames, getSignals, type Signal, type SignalGame } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const MKT: Record<string, string> = { ml: "Moneyline", spread: "Spread", total: "Total" };
/** What DraftKings' juice costs a bettor on top of the no-vig price, per contract: about -110 both sides on spreads and totals, less on moneylines. */
const HALF_VIG: Record<string, number> = { ml: 0.02, spread: 0.0238, total: 0.0238 };

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const se = (a: number[]) => (a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : null);
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;
const pct = (n: number, d = 0) => `${(n * 100).toFixed(d)}%`;
const spct = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const tone = (n: number, eps = 0.001) => (n > eps ? "text-up" : n < -eps ? "text-down" : "text-muted");
const sgn = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const amer = (p: number) => (p >= 0.5 ? `-${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);

/** What a signal's side costs per contract (the chance it wins is what the contract pays, so the cost is that chance at the price taken). */
const cost = (s: Signal) => (s.side > 0 ? s.ref : 1 - s.ref);
const won = (s: Signal) => (s.side > 0 ? s.y === 1 : s.y === 0);

type Dim = { label: string; key: (s: Signal) => string; order?: string[] };
const band = (n: number, cuts: [number, string][], last: string) => cuts.find(([c]) => n < c)?.[1] ?? last;
const HRS: [number, string][] = [[3, "Under 3 h"], [6, "3 to 6 h"], [24, "6 to 24 h"], [72, "1 to 3 days"]];
const HRS_ORDER = ["Under 3 h", "3 to 6 h", "6 to 24 h", "1 to 3 days", "3+ days"];
const SIZE: [number, string][] = [[0.02, "Under 2¢"], [0.03, "2 to 3¢"], [0.05, "3 to 5¢"]];
const SIZE_ORDER = ["Under 2¢", "2 to 3¢", "3 to 5¢", "5¢ or more"];
const PRICE: [number, string][] = [[0.3, "Under 30¢"], [0.45, "30 to 45¢"], [0.55, "45 to 55¢"], [0.7, "55 to 70¢"]];
const PRICE_ORDER = ["Under 30¢", "30 to 45¢", "45 to 55¢", "55 to 70¢", "70¢ or more"];
const monday = (iso: string) => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const DIMS: Record<string, Dim> = {
  sport: { label: "Sport", key: (s) => SPORT[s.sport] ?? s.sport },
  sportkind: { label: "Sport and kind", key: (s) => `${SPORT[s.sport] ?? s.sport} ${s.type === "gap" ? "gaps" : "sharp flow"}` },
  type: { label: "Kind (gap or sharp)", key: (s) => (s.type === "gap" ? "Gap" : "Sharp flow") },
  mkt: { label: "Market", key: (s) => MKT[s.kind] ?? s.kind, order: ["Moneyline", "Spread", "Total"] },
  side: { label: "Side", key: (s) => (s.side > 0 ? "Home / over" : "Away / under") },
  hrs: { label: "Hours before the game", key: (s) => band(s.hrs, HRS, "3+ days"), order: HRS_ORDER },
  size: { label: "Size of the disagreement", key: (s) => band(s.size, SIZE, "5¢ or more"), order: SIZE_ORDER },
  price: { label: "Price paid at DraftKings", key: (s) => band(cost(s), PRICE, "70¢ or more"), order: PRICE_ORDER },
  week: { label: "Week (Mon to Sun)", key: (s) => `Week of ${monday(s.ts).slice(5)}` },
};

function stat(set: Signal[]) {
  const n = set.length;
  const w = set.filter(won).length;
  const costs = set.map(cost), pl = set.map((s) => s.pnl_dk!);
  const hv = set.map((s) => HALF_VIG[s.kind] ?? 0.0238);
  const costV = costs.map((c, i) => Math.min(0.99, c + hv[i]));
  const plV = pl.map((p, i) => p - hv[i]);
  const mc = mean(costs), mcv = mean(costV);
  const roi = mean(pl) / mc, roiV = mean(plV) / mcv;
  const winRate = n ? w / n : 0;
  const mv = set.map((s) => s.moved!);
  return {
    n, w, winRate, be: mc, beV: mcv, edge: winRate - mc, edgeV: winRate - mcv,
    ci: n ? 1.96 * Math.sqrt((mc * (1 - mc)) / n) : 0,
    roi, roiV, roiSe: (se(pl) ?? 0) / mc, units: pl.reduce((a, b) => a + b, 0), unitsV: plV.reduce((a, b) => a + b, 0),
    mv: mean(mv), mvSe: se(mv), pl: mean(pl), plSe: se(pl),
  };
}

function Curve({ set }: { set: Signal[] }) {
  const sorted = [...set].sort((a, b) => a.ts.localeCompare(b.ts));
  if (sorted.length < 3) return null;
  let a = 0, b = 0;
  const raw = sorted.map((s) => (a += s.pnl_dk!));
  const net = sorted.map((s) => (b += s.pnl_dk! - (HALF_VIG[s.kind] ?? 0.0238)));
  const lo = Math.min(0, ...raw, ...net), hi = Math.max(0, ...raw, ...net), span = hi - lo || 1;
  const W = 640, H = 120, X = (i: number) => (i / (sorted.length - 1)) * W, Y = (v: number) => H - ((v - lo) / span) * H;
  const line = (v: number[]) => v.map((y, i) => `${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
  return (
    <div className="mb-6 rounded-lg border border-border bg-surface p-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-muted">
        <span className="font-semibold text-foreground">Running total, one contract on every signal, in time order</span>
        <span><span className="text-up">&#9632;</span> at the no-vig price: {raw[raw.length - 1] >= 0 ? "+" : ""}{raw[raw.length - 1].toFixed(1)} · <span className="text-accent">&#9632;</span> after typical vig: {net[net.length - 1] >= 0 ? "+" : ""}{net[net.length - 1].toFixed(1)} contracts</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Cumulative profit on scored signals">
        <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" className="text-muted" />
        <polyline points={line(raw)} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" className="stroke-up" />
        <polyline points={line(net)} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" className="stroke-accent" />
      </svg>
    </div>
  );
}

/** Home / away / over / under with the number: the bet this signal would be at DraftKings. */
function betLabel(s: Signal): string {
  const [away = "away", home = "home"] = s.teams.split(" @ "); // the order the signal was logged in, which is what its side refers to
  if (s.kind === "ml") return `${s.side > 0 ? home : away} ML`;
  if (s.kind === "spread") return s.side > 0 ? `${home} ${sgn(s.line)}` : `${away} ${sgn(-s.line)}`;
  return `${s.side > 0 ? "Over" : "Under"} ${s.line}`;
}

/** DraftKings' real price on this side right now, when its main line is still the number the signal was logged on. */
function dkNowAmerican(s: Signal, g?: SignalGame): number | null {
  const r = g?.ref;
  if (!r) return null;
  if (s.kind === "ml") return (s.side > 0 ? r.ml_home : r.ml_away) ?? null;
  if (s.kind === "spread") return r.spread === s.line ? ((s.side > 0 ? r.spread_home : r.spread_away) ?? null) : null;
  return r.total === s.line ? ((s.side > 0 ? r.over : r.under) ?? null) : null;
}

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const showAll = sp.all === "1";
  const dupes = sp.dupes === "all";
  const pick = (k: string, ok: string[]) => (sp[k] && ok.includes(sp[k]!) ? sp[k]! : "");
  const f = {
    type: pick("type", ["gap", "sharp"]), sport: pick("sport", Object.keys(SPORT)), mkt: pick("mkt", Object.keys(MKT)), side: pick("side", ["home", "away"]),
    hrs: pick("hrs", HRS_ORDER.map((_, i) => String(i))), size: pick("size", SIZE_ORDER.map((_, i) => String(i))), price: pick("price", PRICE_ORDER.map((_, i) => String(i))),
    days: pick("days", ["7", "14", "30"]),
  };
  const by = DIMS[sp.by ?? ""] ? sp.by! : "sportkind";

  const [{ open, done }, { meta }] = await Promise.all([getSignals(), getExchange()]);
  const cutoff = f.days ? Date.now() - Number(f.days) * 86400000 : 0;
  const keep = (s: Signal) =>
    (!f.type || s.type === f.type) && (!f.sport || s.sport === f.sport) && (!f.mkt || s.kind === f.mkt) &&
    (!f.side || (f.side === "home" ? s.side > 0 : s.side < 0)) &&
    (!f.hrs || DIMS.hrs.key(s) === HRS_ORDER[Number(f.hrs)]) && (!f.size || DIMS.size.key(s) === SIZE_ORDER[Number(f.size)]) &&
    (!f.price || DIMS.price.key(s) === PRICE_ORDER[Number(f.price)]) && (!cutoff || new Date(s.ts).getTime() >= cutoff);
  /** One entry per game and market: the same disagreement is often logged again on the next number over (a spread at 16.5 and then 17.5) or as both a gap and sharp flow, and counting each would make one view look like several. The first one logged is kept. */
  const once = (rows: Signal[]) => {
    if (dupes) return rows;
    const seen = new Set<string>();
    return [...rows].sort((a, b) => a.ts.localeCompare(b.ts)).filter((s) => {
      const k = `${s.game}|${s.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const d = once(done.filter((s) => s.pnl_dk != null && s.moved != null && s.y != null && keep(s))).sort((a, b) => b.ts.localeCompare(a.ts));
  const o = once(open.filter(keep));
  const games = await getSignalGames([...new Set(o.map((s) => s.game))]);
  const OPEN_SHOWN = 60;
  const openSorted = [...o].sort((a, b) => (games[a.game]?.start_utc ?? "").localeCompare(games[b.game]?.start_utc ?? "") || b.size - a.size);
  const openRows = showAll ? openSorted : openSorted.slice(0, OPEN_SHOWN);
  const moreHref = (() => {
    const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    showAll ? p.delete("all") : p.set("all", "1");
    return `/syndicates/signals${p.toString() ? `?${p}` : ""}`;
  })();
  const total = d.length ? stat(d) : null;

  const dim = DIMS[by];
  const rows = new Map<string, Signal[]>();
  for (const s of d) {
    const k = dim.key(s);
    rows.set(k, [...(rows.get(k) ?? []), s]);
  }
  const keys = [...rows.keys()].sort((a, b) => (dim.order ? dim.order.indexOf(a) - dim.order.indexOf(b) : stat(rows.get(b)!).roiV - stat(rows.get(a)!).roiV));

  const sel = "rounded border border-border bg-surface px-2 py-1 text-xs text-foreground";
  const opt = (k: string, label: string, v: string) => <option key={`${k}${v}`} value={v}>{label}</option>;
  const field = (label: string, name: string, cur: string, options: [string, string][]) => (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-muted">
      {label}
      <select name={name} defaultValue={cur} className={`${sel} normal-case tracking-normal`}>
        {options.map(([v, l]) => opt(name, l, v))}
      </select>
    </label>
  );
  const anyFilter = Object.values(f).some(Boolean);
  const nOpen = open.length;

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="signals" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Signal log: when the exchange disagrees with DraftKings, who turns out right?</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Paper only, and not a betting signal. The first time one of a game&rsquo;s main lines shows a disagreement, it is logged with the prices at that moment: either the exchange&rsquo;s price sits 2¢ or more from DraftKings&rsquo;
          (<em>gap</em>, whoever caused it), or traders with a closing-line record have pushed the price 1¢ or more (<em>sharp</em>, which needs someone to have earned that record first). When the game ends it is scored:
          <strong> did DraftKings&rsquo; close move toward it</strong> (the cleanest test, no luck from the result), and <strong>what a contract on its side made at DraftKings&rsquo; price</strong> (noisy, so look at the range). Only games DraftKings priced count.
        </p>

        <form method="get" className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
          {field("Kind", "type", f.type, [["", "Both"], ["gap", "Gap"], ["sharp", "Sharp flow"]])}
          {field("Sport", "sport", f.sport, [["", "All"], ...Object.entries(SPORT)])}
          {field("Market", "mkt", f.mkt, [["", "All"], ...Object.entries(MKT)])}
          {field("Side", "side", f.side, [["", "Both"], ["home", "Home / over"], ["away", "Away / under"]])}
          {field("Hours out", "hrs", f.hrs, [["", "Any"], ...HRS_ORDER.map((l, i): [string, string] => [String(i), l])])}
          {field("Size", "size", f.size, [["", "Any"], ...SIZE_ORDER.map((l, i): [string, string] => [String(i), l])])}
          {field("Price paid", "price", f.price, [["", "Any"], ...PRICE_ORDER.map((l, i): [string, string] => [String(i), l])])}
          {field("Logged in", "days", f.days, [["", "All time"], ["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"]])}
          {field("Repeats", "dupes", dupes ? "all" : "", [["", "One per game and market"], ["all", "Every entry"]])}
          {field("Break down by", "by", by, Object.entries(DIMS).map(([k, v]): [string, string] => [k, v.label]))}
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-background">Apply</button>
          {anyFilter || dupes || by !== "sportkind" ? <Link href="/syndicates/signals" className="py-1.5 text-xs text-muted hover:text-foreground">Reset</Link> : null}
          <span className="ml-auto self-center text-[11px] text-muted">{d.length} scored · {o.length} open{anyFilter || !dupes ? ` (of ${done.length} and ${nOpen} logged)` : ""}</span>
        </form>

        {!total ? (
          <p className="mb-8 rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">{anyFilter ? "No scored signals match these filters." : "Nothing scored yet: entries are scored as their games finish."}</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {[
                ["Scored", String(total.n), "text-foreground", `${total.w} won, ${total.n - total.w} lost`],
                ["Win rate", pct(total.winRate, 1), tone(total.edge), `±${(total.ci * 100).toFixed(1)} points (95%)`],
                ["Breakeven needed", pct(total.be, 1), "text-foreground", `${pct(total.beV, 1)} after DraftKings' vig`],
                ["Edge over breakeven", `${total.edge >= 0 ? "+" : ""}${(total.edge * 100).toFixed(1)} pts`, tone(total.edge), `${total.edgeV >= 0 ? "+" : ""}${(total.edgeV * 100).toFixed(1)} after vig`],
                ["ROI, no-vig price", spct(total.roi), tone(total.roi), `±${(196 * total.roiSe).toFixed(1)}% · ${total.units >= 0 ? "+" : ""}${total.units.toFixed(1)} contracts`],
                ["ROI after typical vig", spct(total.roiV), tone(total.roiV), `${total.unitsV >= 0 ? "+" : ""}${total.unitsV.toFixed(1)} contracts`],
              ].map(([k, v, t, sub]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">{k}</div>
                  <div className={`font-mono text-lg ${t}`}>{v}</div>
                  <div className="text-[10px] text-muted">{sub}</div>
                </div>
              ))}
            </div>
            <p className="mb-4 max-w-3xl text-[11px] leading-relaxed text-muted">
              Every signal is treated as one contract bought at DraftKings&rsquo; no-vig price when it was logged, so the breakeven win rate is just that price (a 55¢ side must win 55% of the time).
              DraftKings charges juice on top, about 2 to 2.4¢ per contract, so the &ldquo;after vig&rdquo; figures are what a bettor could realistically expect. DraftKings&rsquo; close moved toward the signal by {c1(total.mv)} on average
              {total.mvSe != null ? ` (±${(196 * total.mvSe).toFixed(1)})` : ""}, which does not depend on luck.
            </p>

            <Curve set={d} />

            <div className="mb-8 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">{dim.label}</th>
                    <th className="px-3 py-2 text-right">Scored</th>
                    <th className="px-3 py-2 text-right" title="Share of signals whose side won (pushes are not counted)">Win rate</th>
                    <th className="px-3 py-2 text-right" title="Average price paid at DraftKings' no-vig price: the win rate you need to break even">Breakeven</th>
                    <th className="px-3 py-2 text-right" title="Win rate minus breakeven, in percentage points">Edge</th>
                    <th className="px-3 py-2 text-right" title="Profit divided by what was put up, at the no-vig price">ROI</th>
                    <th className="px-3 py-2 text-right" title="The same after about 2 to 2.4¢ of DraftKings juice per contract">ROI after vig</th>
                    <th className="px-3 py-2 text-right" title="Average move of DraftKings' price from the moment of the signal to the close, in the signal's direction">DK moved toward it</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[["All of the above", d] as [string, Signal[]], ...keys.map((k) => [k, rows.get(k)!] as [string, Signal[]])].map(([name, set], i) => {
                    const s = stat(set);
                    return (
                      <tr key={name} className={`border-t border-border ${i === 0 ? "bg-surface/60 font-semibold" : ""} ${set.length < 30 && i > 0 ? "opacity-60" : ""}`}>
                        <td className="px-3 py-1.5 font-sans text-foreground">{name}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{s.n}</td>
                        <td className="px-3 py-1.5 text-right">{pct(s.winRate, 1)}<span className="ml-1 text-[10px] text-muted">±{(s.ci * 100).toFixed(0)}</span></td>
                        <td className="px-3 py-1.5 text-right text-muted">{pct(s.be, 1)}</td>
                        <td className={`px-3 py-1.5 text-right ${tone(s.edge)}`}>{s.edge >= 0 ? "+" : ""}{(s.edge * 100).toFixed(1)}</td>
                        <td className={`px-3 py-1.5 text-right ${tone(s.roi)}`}>{spct(s.roi)}<span className="ml-1 text-[10px] text-muted">±{(196 * s.roiSe).toFixed(0)}</span></td>
                        <td className={`px-3 py-1.5 text-right ${tone(s.roiV)}`}>{spct(s.roiV)}</td>
                        <td className={`px-3 py-1.5 text-right ${tone(s.mv)}`}>{c1(s.mv)}{s.mvSe != null && <span className="ml-1 text-[10px] text-muted">±{(196 * s.mvSe).toFixed(1)}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="-mt-6 mb-8 text-[10px] text-muted">Rows with fewer than 30 signals are dimmed: too few to read. The ± is a 95% range.</p>
          </>
        )}

        <h3 className="mb-1 text-sm font-semibold text-foreground">Open signals: what you would bet now</h3>
        <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
          Signals whose games have not finished. <strong>Bet</strong> is the side the signal points to. <strong>Play price</strong> is DraftKings&rsquo; no-vig price when it was logged, with the American odds it equals before juice.
          <strong> DK now</strong> is DraftKings&rsquo; real price on that side if its main line is still the same number, and <strong>Moved</strong> is how far DraftKings&rsquo; price has already gone toward the signal (the live version of the close test).
        </p>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[980px] text-xs">
            <thead className="bg-surface text-left text-muted">
              <tr>
                <th className="px-3 py-2">Game</th><th className="px-3 py-2">Bet</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Starts</th>
                <th className="px-3 py-2 text-right" title="Gap between the exchange and DraftKings, or the sharp push, when it was logged">Size</th>
                <th className="px-3 py-2 text-right" title="DraftKings' no-vig price for this side when the signal was logged, and the American odds it equals">Play price</th>
                <th className="px-3 py-2 text-right" title="The exchange's two-sided price for this side when logged">Exchange then</th>
                <th className="px-3 py-2 text-right" title="DraftKings' real American price on this side now, if the number is unchanged">DK now</th>
                <th className="px-3 py-2 text-right" title="Change in DraftKings' no-vig price since the signal, in the signal's direction">Moved</th>
                <th className="px-3 py-2 text-right">Exchange now</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {o.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center font-sans text-muted">{anyFilter ? "No open signals match these filters." : "No open signals right now."}</td></tr>
              ) : (
                openRows.map((s) => {
                  const g = games[s.game];
                  const row = g?.book?.find((r) => r[0] === s.kind && r[1] === s.line);
                  const dkP = row ? row[2] : null, exP = row?.[9] ?? null;
                  const moved = dkP != null ? s.side * (dkP - s.ref) : null;
                  const live = g && g.state !== "pre";
                  const side = (p: number) => (s.side > 0 ? p : 1 - p);
                  const now = dkNowAmerican(s, g);
                  return (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/games/${encodeURIComponent(s.game)}`} className="hover:text-accent">{s.teams}</Link><span className="ml-1.5 text-[10px] uppercase text-muted">{SPORT[s.sport]}</span></td>
                      <td className="px-3 py-1.5 font-sans font-semibold text-foreground">{betLabel(s)}</td>
                      <td className="px-3 py-1.5 font-sans text-muted">{s.type === "gap" ? "gap" : "sharp"}</td>
                      <td className="px-3 py-1.5 text-muted">{g ? (live ? <span className="text-accent">{g.completed ? "final" : "live"}</span> : <LocalDateTime iso={g.start_utc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />) : "–"}</td>
                      <td className="px-3 py-1.5 text-right">{c1(s.size)}</td>
                      <td className="px-3 py-1.5 text-right">{(side(s.ref) * 100).toFixed(1)}¢<span className="ml-1 text-[10px] text-muted">{amer(side(s.ref))}</span></td>
                      <td className="px-3 py-1.5 text-right text-muted">{s.x == null ? "–" : `${(side(s.x) * 100).toFixed(1)}¢`}</td>
                      <td className="px-3 py-1.5 text-right">{now == null ? <span className="text-[10px] text-muted">{s.kind !== "ml" && g?.ref ? "line moved" : "–"}</span> : now > 0 ? `+${Math.round(now)}` : Math.round(now)}</td>
                      <td className={`px-3 py-1.5 text-right ${moved == null ? "text-muted" : tone(moved)}`}>{moved == null ? "–" : c1(moved)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{exP == null ? "–" : `${(side(exP) * 100).toFixed(1)}¢`}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {o.length > OPEN_SHOWN ? (
          <p className="-mt-6 mb-8 text-[11px] text-muted">
            Showing {showAll ? `all ${o.length}` : `the next ${OPEN_SHOWN} of ${o.length}`}, soonest games first. <Link href={moreHref} className="text-accent hover:underline">{showAll ? "Show fewer" : "Show all"}</Link>
          </p>
        ) : null}

        <h3 className="mb-2 text-sm font-semibold text-foreground">Latest scored{anyFilter ? " (filtered)" : ""}</h3>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-xs">
            <thead className="bg-surface text-left text-muted">
              <tr>
                <th className="px-3 py-2">When</th><th className="px-3 py-2">Game</th><th className="px-3 py-2">Bet</th><th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2 text-right">Hours out</th><th className="px-3 py-2 text-right">Play price</th><th className="px-3 py-2 text-right">Exchange then</th>
                <th className="px-3 py-2 text-right">DK close</th><th className="px-3 py-2 text-right">Result</th><th className="px-3 py-2 text-right">Made</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {d.slice(0, 40).map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-muted"><LocalDateTime iso={s.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                  <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/games/${encodeURIComponent(s.game)}`} className="hover:text-accent">{s.teams}</Link><span className="ml-1.5 text-[10px] uppercase text-muted">{SPORT[s.sport]}</span></td>
                  <td className="px-3 py-1.5 font-sans text-foreground">{betLabel(s)}</td>
                  <td className="px-3 py-1.5 font-sans text-muted">{s.type}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{s.hrs}</td>
                  <td className="px-3 py-1.5 text-right">{(cost(s) * 100).toFixed(1)}¢</td>
                  <td className="px-3 py-1.5 text-right text-muted">{s.x == null ? "–" : `${((s.side > 0 ? s.x : 1 - s.x) * 100).toFixed(1)}¢`}</td>
                  <td className={`px-3 py-1.5 text-right ${tone(s.moved!)}`}>{((s.side > 0 ? s.dk_close! : 1 - s.dk_close!) * 100).toFixed(1)}¢</td>
                  <td className={`px-3 py-1.5 text-right ${won(s) ? "text-up" : "text-down"}`}>{won(s) ? "won" : "lost"}</td>
                  <td className={`px-3 py-1.5 text-right ${tone(s.pnl_dk!)}`}>{c1(s.pnl_dk!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
