import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { getClosings, getExchange } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const f4 = (n: number) => n.toFixed(4);
const c1 = (p: number | null | undefined) => (p == null ? "–" : `${(p * 100).toFixed(1)}¢`);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const brier = (p: number, y: number) => (p - y) ** 2;

type Obs = { game: string; sport: string; kind: string; line: number; dk: number; p: number; y: number };

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ sport?: string; syn?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const [results, { syndicates, meta }] = await Promise.all([getClosings(), getExchange()]);
  const games = results.filter((r) => r.closing && (r.closing.src ?? "dk") === "dk" && r.closing.e && (!sport || r.sport === sport));

  // each syndicate's model price for the game's three main lines, scored against DraftKings' closing price on the same lines
  const obsOf = (sid: string): Obs[] => {
    const out: Obs[] = [];
    for (const r of games) {
      const c = r.closing!;
      const e = c.e?.[sid];
      if (!e) continue;
      c.lines.forEach(([kind, line], i) => {
        if (e[i] == null || c.y[i] == null || c.y[i] === 0.5 || c.dk[i] == null) return;
        out.push({ game: r.id, sport: r.sport, kind, line, dk: c.dk[i], p: e[i], y: c.y[i] });
      });
    }
    return out;
  };
  const score = (set: Obs[]) => {
    const d = set.map((o) => brier(o.dk, o.y) - brier(o.p, o.y));
    const m = mean(d);
    const s = set.length > 1 ? Math.sqrt(d.reduce((a, v) => a + (v - m) ** 2, 0) / (set.length - 1) / set.length) : null;
    return { n: set.length, dkB: mean(set.map((o) => brier(o.dk, o.y))), mB: mean(set.map((o) => brier(o.p, o.y))), edge: m, z: s ? m / s : null, closer: set.length ? set.filter((o) => Math.abs(o.p - o.y) < Math.abs(o.dk - o.y)).length / set.length : null, gap: mean(set.map((o) => Math.abs(o.p - o.dk))) };
  };
  const rows = syndicates.filter((s) => s.engine !== "mm" && s.engine !== "ref" && s.engine !== "public").map((s) => ({ s, ...score(obsOf(s.id)) })).filter((r) => r.n > 0).sort((a, b) => b.edge - a.edge);
  const picked = syndicates.find((s) => s.id === (sp.syn ?? "house")) ?? syndicates.find((s) => s.id === "house") ?? null;
  const pickedObs = picked ? obsOf(picked.id) : [];
  const bySport = SPORTS.map((s) => [s, score(pickedObs.filter((o) => o.sport === s))] as const).filter(([, v]) => v.n > 0);
  const gameList = picked ? games.filter((r) => r.closing!.e?.[picked.id]).slice(0, 40) : [];
  const q = (o: { sport?: string | null; syn?: string }) => {
    const p = new URLSearchParams();
    const s = o.sport === undefined ? sport : o.sport;
    if (s) p.set("sport", s);
    p.set("syn", o.syn ?? picked?.id ?? "house");
    return `/syndicates/models?${p}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="models" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Model scorecard</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Each syndicate with a model has its own price for every line before any trading. Once a game is over, that price is scored against what happened and compared with DraftKings&rsquo; closing price on the same line
          (Brier score: average squared miss, lower is better). A model that beats DraftKings has real information; one that does not should be trusted less, which is what the learned weights and the per-game limits do. These are the
          raw model prices, not the trades, so unlike closing-line value this shows whether the <em>view</em> is any good.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted">Sport</span>
          <Link href={q({ sport: null })} className={chip(!sport)}>All</Link>
          {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
        </div>

        {!rows.length ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            Nothing to score yet. Model prices are recorded with each game&rsquo;s closing prices once <code>supabase/exchange_update_5.sql</code> has been run and games finish.
          </p>
        ) : (
          <>
            <section className="mb-8">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">Syndicate</th>
                      <th className="px-3 py-2 text-right">Prices scored</th>
                      <th className="px-3 py-2 text-right">DraftKings Brier</th>
                      <th className="px-3 py-2 text-right">Model Brier</th>
                      <th className="px-3 py-2 text-right" title="Positive: the model was closer to what happened than DraftKings, per 1000 prices">Better by</th>
                      <th className="px-3 py-2 text-right" title="Standard errors from zero; under 2 is not distinguishable from luck">z</th>
                      <th className="px-3 py-2 text-right">Closer than DK</th>
                      <th className="px-3 py-2 text-right" title="Average distance between the model's price and DraftKings'">Avg disagreement</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {rows.map((r) => (
                      <tr key={r.s.id} className={`border-t border-border ${r.s.id === picked?.id ? "bg-surface" : ""}`}>
                        <td className="px-3 py-1.5 font-sans text-foreground">
                          <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.s.color }} />
                          <Link href={q({ syn: r.s.id })} className="hover:text-accent">{r.s.name}</Link>
                        </td>
                        <td className="px-3 py-1.5 text-right text-muted">{r.n}</td>
                        <td className="px-3 py-1.5 text-right">{f4(r.dkB)}</td>
                        <td className="px-3 py-1.5 text-right">{f4(r.mB)}</td>
                        <td className={`px-3 py-1.5 text-right ${r.edge > 0 ? "text-up" : "text-down"}`}>{(r.edge * 1000).toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{r.z == null ? "–" : r.z.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right">{r.closer == null ? "–" : `${(r.closer * 100).toFixed(0)}%`}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{c1(r.gap)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Market makers and the control group have no model of their own, so they are not listed. Prices from one game are not independent, so treat a z under 3 as unproven.</p>
            </section>

            {picked && (
              <section className="mb-8">
                <h3 className="mb-2 text-sm font-semibold text-foreground">{picked.name}: by sport and game</h3>
                <div className="mb-4 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Sport</th><th className="px-3 py-2 text-right">Prices</th><th className="px-3 py-2 text-right">DraftKings Brier</th><th className="px-3 py-2 text-right">Model Brier</th><th className="px-3 py-2 text-right">Better by</th><th className="px-3 py-2 text-right">Avg disagreement</th></tr></thead>
                    <tbody className="font-mono">
                      {bySport.map(([s, v]) => (
                        <tr key={s} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground">{SPORT[s]}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{v.n}</td>
                          <td className="px-3 py-1.5 text-right">{f4(v.dkB)}</td>
                          <td className="px-3 py-1.5 text-right">{f4(v.mB)}</td>
                          <td className={`px-3 py-1.5 text-right ${v.edge > 0 ? "text-up" : "text-down"}`}>{(v.edge * 1000).toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{c1(v.gap)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[760px] text-xs">
                    <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Line</th><th className="px-3 py-2 text-right">DraftKings</th><th className="px-3 py-2 text-right">{picked.name}</th><th className="px-3 py-2 text-right">Kalshi</th><th className="px-3 py-2 text-right">Happened</th></tr></thead>
                    <tbody className="font-mono">
                      {gameList.flatMap((r) =>
                        r.closing!.lines.map(([kind, line], i) => {
                          const c = r.closing!;
                          const p = c.e?.[picked.id]?.[i];
                          const y = c.y[i];
                          const better = p != null && y !== 0.5 ? Math.abs(p - y) < Math.abs(c.dk[i] - y) : null;
                          return (
                            <tr key={`${r.id}-${i}`} className="border-t border-border">
                              {i === 0 ? <td rowSpan={c.lines.length} className="px-3 py-1.5 align-top font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[r.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(r.id)}`} className="hover:text-accent">{r.away.abbr} @ {r.home.abbr}</Link><span className="ml-2 text-muted">{r.away_score}-{r.home_score}</span></td> : null}
                              <td className="px-3 py-1.5 font-sans">{kind === "ml" ? `${r.home.abbr} ML` : kind === "spread" ? `${r.home.abbr} ${line > 0 ? "+" : ""}${line}` : `Over ${line}`}</td>
                              <td className="px-3 py-1.5 text-right">{c1(c.dk[i])}</td>
                              <td className={`px-3 py-1.5 text-right ${better == null ? "text-muted" : better ? "text-up" : "text-down"}`}>{c1(p)}</td>
                              <td className="px-3 py-1.5 text-right text-muted">{c1(c.ks?.[i])}</td>
                              <td className="px-3 py-1.5 text-right">{y === 1 ? "yes" : y === 0 ? "no" : "push"}</td>
                            </tr>
                          );
                        }),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[11px] text-muted">Green means the model&rsquo;s price was closer to what happened than DraftKings&rsquo;; red means further.</p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
