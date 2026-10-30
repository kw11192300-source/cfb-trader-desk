import Link from "next/link";

import { ReliabilityChart, type RelSeries } from "@/components/ReliabilityChart";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getClosings, getExchange, getReliability, relBins, type RelBin, relSummary } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const KINDS = ["ml", "spread", "total"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const KIND: Record<string, string> = { ml: "Moneyline", spread: "Spread", total: "Total" };
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;
type Params = { scope?: string; id?: string; sport?: string; kind?: string };

/** Ten price bins from plain (price, happened) pairs, one observation each. */
function binsOf(pairs: [number, number][]): RelBin[] {
  const acc = Array.from({ length: 10 }, () => [0, 0, 0]);
  for (const [p, y] of pairs) {
    const i = Math.min(9, Math.max(0, Math.floor(p * 10)));
    acc[i][0] += 1; acc[i][1] += p; acc[i][2] += y;
  }
  return acc.map((v, bin) => ({ bin, n: v[0], w: v[0], p: v[0] ? v[1] / v[0] : 0, f: v[0] ? v[2] / v[0] : 0 })).filter((b) => b.n > 0);
}

export default async function ReliabilityPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const [{ syndicates, members, meta }, rel, closings] = await Promise.all([getExchange(), getReliability(), getClosings()]);
  const scope = sp.scope === "s" || sp.scope === "m" ? sp.scope : "x";
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const kind = KINDS.includes(sp.kind ?? "") ? sp.kind! : null;
  const syn = scope === "s" ? syndicates.find((s) => s.id === sp.id) ?? syndicates[0] : null;
  const mem = scope === "m" ? members.find((m) => m.id === sp.id) ?? members[0] : null;
  const entity = scope === "x" ? "x" : scope === "s" ? `s:${syn!.id}` : `m:${mem!.id}`;
  const title = scope === "x" ? "The exchange" : scope === "s" ? syn!.name : `${mem!.name} (${syndicates.find((s) => s.id === mem!.syndicate_id)?.name})`;
  const q = (o: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { scope, id: sp.id, sport: sport ?? undefined, kind: kind ?? undefined, ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/reliability?${p}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  const bins = relBins(rel.cells, entity, sport, kind);
  const sum = relSummary(bins);
  const series: RelSeries[] = [{ name: scope === "x" ? "Prices traded on the exchange" : "Prices paid for their side", color: "#2563eb", bins }];

  // the closing prices of the three main lines, scored once a game is over: the exchange's, DraftKings' and Kalshi's; for a syndicate, its model's price
  const fin = closings.filter((r) => r.closing && (!sport || r.sport === sport));
  const pairs = (pick: (c: NonNullable<(typeof fin)[number]["closing"]>, i: number) => number | null | undefined) =>
    fin.flatMap((r) => r.closing!.lines.flatMap(([k], i) => {
      const y = r.closing!.y[i], p = pick(r.closing!, i);
      return (kind && k !== kind) || p == null || y == null || y === 0.5 ? [] : [[p, y] as [number, number]];
    }));
  const closeSeries: RelSeries[] =
    scope === "x"
      ? [
          { name: "Exchange close", color: "#2563eb", bins: binsOf(pairs((c, i) => c.x?.[i])) },
          { name: "DraftKings close", color: "#f59e0b", bins: binsOf(pairs((c, i) => ((c.src ?? "dk") === "dk" ? c.dk[i] : null))) },
          { name: "Kalshi", color: "#10b981", bins: binsOf(pairs((c, i) => c.ks?.[i])) },
        ]
      : scope === "s"
        ? [{ name: `${syn!.name} model`, color: syn!.color, bins: binsOf(pairs((c, i) => c.e?.[syn!.id]?.[i])) }, { name: "DraftKings close", color: "#f59e0b", bins: binsOf(pairs((c, i) => ((c.src ?? "dk") === "dk" ? c.dk[i] : null))) }]
        : [];

  // the grid: bias by sport and market for every group (or every trader)
  const cols = SPORTS.flatMap((s) => KINDS.map((k) => [s, k] as const));
  const gridRows =
    scope === "x"
      ? [{ id: "x", name: "The exchange", link: null as string | null, entity: "x" }]
      : scope === "s"
        ? syndicates.map((s) => ({ id: s.id, name: s.name, link: q({ scope: "s", id: s.id }), entity: `s:${s.id}` }))
        : members.map((m) => ({ id: m.id, name: `${m.name} · ${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""}`, link: q({ scope: "m", id: m.id }), entity: `m:${m.id}` }));
  const shade = (b: number | null, n: number) => (b == null || n < 5 ? undefined : { background: `${b > 0 ? "rgba(34,197,94," : "rgba(239,68,68,"}${Math.min(0.4, (Math.abs(b) / 0.1) * 0.4)})` });

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="reliability" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Reliability: when a price says 60¢, does it happen 60% of the time?</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Each dot is a group of settled trades at similar prices: how much the side cost against how often it won. A perfectly calibrated price sits on the dashed line. For the exchange the price is the yes-price traded; for a syndicate or a trader it is what they
          paid for the side they took, so a dot <em>above</em> the line means that side won more often than it cost (they were getting value) and <em>below</em> means they overpaid. Bars show a 95% range; they are wide until there are hundreds of trades.
          So far {rel.games} finished games are counted, and the record is kept forever.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <div className="flex gap-1">
            <span className="py-1 text-muted">Who</span>
            <Link href={q({ scope: "x", id: undefined })} className={chip(scope === "x")}>Exchange</Link>
            <Link href={q({ scope: "s", id: sp.id && scope === "s" ? sp.id : syndicates[0]?.id })} className={chip(scope === "s")}>Syndicate</Link>
            <Link href={q({ scope: "m", id: sp.id && scope === "m" ? sp.id : members[0]?.id })} className={chip(scope === "m")}>Trader</Link>
          </div>
          <div className="flex flex-wrap gap-1">
            <span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex gap-1">
            <span className="py-1 text-muted">Market</span>
            <Link href={q({ kind: undefined })} className={chip(!kind)}>All</Link>
            {KINDS.map((k) => <Link key={k} href={q({ kind: k })} className={chip(kind === k)}>{KIND[k]}</Link>)}
          </div>
          {scope !== "x" && (
            <form method="get" action="/syndicates/reliability" className="flex items-center gap-2">
              <input type="hidden" name="scope" value={scope} />
              {sport && <input type="hidden" name="sport" value={sport} />}
              {kind && <input type="hidden" name="kind" value={kind} />}
              <select name="id" defaultValue={scope === "s" ? syn!.id : mem!.id} className="rounded border border-border bg-background px-2 py-1 text-foreground">
                {scope === "s"
                  ? syndicates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
                  : syndicates.map((s) => <optgroup key={s.id} label={s.name}>{members.filter((m) => m.syndicate_id === s.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}
              </select>
              <button type="submit" className="rounded bg-accent px-2.5 py-1 font-medium text-background">Show</button>
            </form>
          )}
        </div>

        <h3 className="mb-2 mt-5 text-sm font-semibold text-foreground">
          {title}{sport ? ` · ${SPORT[sport]}` : ""}{kind ? ` · ${KIND[kind]}` : ""}
        </h3>
        <div className="mb-8 grid gap-6 md:grid-cols-[minmax(0,420px)_1fr]">
          <div>
            {bins.length ? <ReliabilityChart series={series} /> : <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-xs text-muted">No settled trades in this selection yet.</p>}
          </div>
          <div>
            <div className="mb-3 grid grid-cols-3 gap-3">
              {[["Trades", String(sum.n)], ["Contracts", sum.w.toFixed(0)], [scope === "x" ? "Yes ran vs price" : "Won vs paid", sum.bias == null ? "–" : c1(sum.bias)]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
              ))}
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Price</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">Contracts</th><th className="px-3 py-2 text-right">Avg price</th><th className="px-3 py-2 text-right">Happened</th><th className="px-3 py-2 text-right">Difference</th></tr></thead>
                <tbody className="font-mono">
                  {bins.map((b) => (
                    <tr key={b.bin} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-muted">{b.bin * 10}–{b.bin * 10 + 10}¢</td>
                      <td className="px-3 py-1.5 text-right">{b.n}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{b.w.toFixed(0)}</td>
                      <td className="px-3 py-1.5 text-right">{(b.p * 100).toFixed(1)}¢</td>
                      <td className="px-3 py-1.5 text-right">{(b.f * 100).toFixed(1)}%</td>
                      <td className={`px-3 py-1.5 text-right ${b.f - b.p > 0 ? "text-up" : "text-down"}`}>{c1(b.f - b.p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {closeSeries.length > 0 && (
          <section className="mb-8">
            <h3 className="mb-1 text-sm font-semibold text-foreground">{scope === "x" ? "Closing prices: exchange vs DraftKings vs Kalshi" : "Model price at the close vs DraftKings"}</h3>
            <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
              Each finished game contributes its moneyline, main spread and main total, so this fills in slowly: {closeSeries[0].bins.reduce((a, b) => a + b.n, 0)} prices so far. This is the
              cleanest view of whether the <em>exchange price itself</em> is trustworthy, separate from who traded at what.
            </p>
            {closeSeries.some((s) => s.bins.length) ? <ReliabilityChart series={closeSeries.filter((s) => s.bins.length)} /> : <p className="text-xs text-muted">Nothing yet for this selection.</p>}
          </section>
        )}

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">{scope === "x" ? "By sport and market" : scope === "s" ? "Every syndicate, by sport and market" : "Every trader, by sport and market"}</h3>
          <p className="mb-2 text-[11px] text-muted">
            Each cell is the average gap between how often the side won and what it cost, per contract (green: got more than paid for), with the number of trades under it. Cells under 5 trades are left unshaded. Click a name to chart it.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1100px] text-[11px]">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-1.5" rowSpan={2}>{scope === "x" ? "" : scope === "s" ? "Syndicate" : "Trader"}</th>
                  {SPORTS.map((s) => <th key={s} colSpan={3} className="border-l border-border px-2 py-1 text-center">{SPORT[s]}</th>)}
                </tr>
                <tr>{SPORTS.flatMap((s) => KINDS.map((k, i) => <th key={`${s}${k}`} className={`px-2 py-1 text-center font-normal ${i === 0 ? "border-l border-border" : ""}`}>{KIND[k].slice(0, 2) === "Mo" ? "ML" : KIND[k]}</th>))}</tr>
              </thead>
              <tbody className="font-mono">
                {gridRows.map((r) => (
                  <tr key={r.id} className={`border-t border-border ${r.entity === entity ? "bg-surface" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-1 font-sans text-foreground">{r.link ? <Link href={r.link} className="hover:text-accent">{r.name}</Link> : r.name}</td>
                    {cols.map(([s, k], i) => {
                      const b = relSummary(relBins(rel.cells, r.entity, s, k));
                      return (
                        <td key={`${s}${k}`} style={shade(b.bias, b.n)} className={`px-2 py-1 text-center ${i % 3 === 0 ? "border-l border-border" : ""}`}>
                          {b.bias == null ? <span className="text-muted">·</span> : <>{c1(b.bias)}<span className="block text-[9px] text-muted">{b.n}</span></>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
