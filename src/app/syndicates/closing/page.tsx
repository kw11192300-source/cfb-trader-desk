import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { getClosings, getExchange } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const c1 = (p: number | null | undefined) => (p == null ? "–" : `${(p * 100).toFixed(1)}¢`);
const f4 = (n: number) => n.toFixed(4);

type Obs = { game: string; sport: string; kind: string; line: number; dk: number; x: number | null; ks: number | null; y: number; sharp: number };

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const se = (a: number[]) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1) / a.length);
};
const brier = (p: number, y: number) => (p - y) ** 2;
const logloss = (p: number, y: number) => -(y * Math.log(Math.min(0.999, Math.max(0.001, p))) + (1 - y) * Math.log(1 - Math.min(0.999, Math.max(0.001, p))));

/** Scores one source against DraftKings on the same observations. Positive "edge" means the source was closer to what happened. */
function versus(set: Obs[], pick: (o: Obs) => number | null) {
  const rows = set.filter((o) => pick(o) != null);
  const d = rows.map((o) => brier(o.dk, o.y) - brier(pick(o)!, o.y));
  const s = se(d);
  return {
    n: rows.length,
    dkB: mean(rows.map((o) => brier(o.dk, o.y))),
    srcB: mean(rows.map((o) => brier(pick(o)!, o.y))),
    dkL: mean(rows.map((o) => logloss(o.dk, o.y))),
    srcL: mean(rows.map((o) => logloss(pick(o)!, o.y))),
    edge: mean(d),
    z: s ? mean(d) / s : null,
    closer: rows.length ? rows.filter((o) => Math.abs(pick(o)! - o.y) < Math.abs(o.dk - o.y)).length / rows.length : null,
  };
}

export default async function ClosingPage() {
  const [results, { meta }] = await Promise.all([getClosings(), getExchange()]);
  const dkGames = results.filter((r) => r.closing && (r.closing.src ?? "dk") === "dk" && r.closing.y?.length);
  const obs: Obs[] = [];
  for (const r of dkGames) {
    const c = r.closing!;
    c.lines.forEach(([kind, line], i) => {
      const y = c.y[i];
      if (y == null || y === 0.5 || c.dk[i] == null) return;
      obs.push({ game: r.id, sport: r.sport, kind, line, dk: c.dk[i], x: c.x?.[i] ?? null, ks: c.ks?.[i] ?? null, y, sharp: c.sharp?.[i] ?? 0 });
    });
  }
  const withX = obs.filter((o) => o.x != null);
  const all = versus(obs, (o) => o.x);
  const kal = versus(obs, (o) => o.ks);
  const sports = [...new Set(obs.map((o) => o.sport))];

  // does the gap between the exchange and DraftKings predict what happened beyond DraftKings' own price?
  const g = withX.map((o) => o.x! - o.dk);
  const r = withX.map((o) => o.y - o.dk);
  const gg = g.reduce((s, v) => s + v * v, 0);
  const slope = gg > 1e-9 ? g.reduce((s, v, i) => s + v * r[i], 0) / gg : null;
  const slopeSe = slope != null && withX.length > 2 ? Math.sqrt(r.reduce((s, v, i) => s + (v - slope * g[i]) ** 2, 0) / (withX.length - 1) / gg) : null;

  const buckets: [string, (gap: number) => boolean][] = [
    ["Under 1¢ apart", (x) => x < 0.01],
    ["1¢ to 3¢ apart", (x) => x >= 0.01 && x < 0.03],
    ["3¢ or more apart", (x) => x >= 0.03],
  ];
  const bucketRows = buckets.map(([name, f]) => {
    const set = withX.filter((o) => f(Math.abs(o.x! - o.dk)));
    return { name, n: set.length, closer: set.length ? set.filter((o) => Math.abs(o.x! - o.y) < Math.abs(o.dk - o.y)).length / set.length : null, dkB: mean(set.map((o) => brier(o.dk, o.y))), xB: mean(set.map((o) => brier(o.x!, o.y))) };
  });
  const moved = withX.filter((o) => Math.abs(o.x! - o.dk) >= 0.01);
  const sharpSets: [string, Obs[]][] = [
    ["Sharp traders pushed the same way", moved.filter((o) => o.sharp * (o.x! - o.dk) > 0 && Math.abs(o.sharp) >= 1)],
    ["Sharp traders pushed the other way", moved.filter((o) => o.sharp * (o.x! - o.dk) < 0 && Math.abs(o.sharp) >= 1)],
    ["No sharp trading", moved.filter((o) => Math.abs(o.sharp) < 1)],
  ];

  const gameRows = dkGames.slice(0, 40);
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="closing" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Exchange close vs DraftKings close</h2>
        <p className="mb-5 max-w-3xl text-xs leading-relaxed text-muted">
          At each game&rsquo;s last round the exchange has its own price for the moneyline, the main spread and the main total, next to DraftKings&rsquo; closing price (and Kalshi&rsquo;s, where listed). Each price is a probability, so
          once the game ends it can be scored against what happened: the Brier score is the average squared miss (0 is perfect, lower is better). If the exchange scores better than DraftKings it found
          something DraftKings did not. If it drifts from DraftKings and scores worse, the drift was noise, not information. The exchange moving away from DraftKings is fine when sharp traders were behind the move; the tables below split it that way.
        </p>

        {!obs.length ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            Nothing to score yet. Closing prices are recorded as each game finishes (after <code>supabase/exchange_update_5.sql</code> has been run), so this fills in as games settle.
          </p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Games / prices scored", `${dkGames.length} / ${all.n}`],
                ["Brier: DraftKings", f4(all.dkB)],
                ["Brier: exchange", all.n ? f4(all.srcB) : "–"],
                ["Exchange better by", all.n ? `${(all.edge * 1000).toFixed(2)} per 1000${all.z != null ? ` (z ${all.z.toFixed(1)})` : ""}` : "–"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
              ))}
            </div>
            <p className="mb-6 max-w-3xl text-[11px] leading-relaxed text-muted">
              z measures how many standard errors the difference is from zero; under about 2 it is indistinguishable from luck, and the three prices from one game are not independent, so be stricter than that. Log loss: DraftKings {all.n ? all.dkL.toFixed(4) : "–"} vs exchange {all.n ? all.srcL.toFixed(4) : "–"}.
              Exchange closer than DraftKings on {all.closer == null ? "–" : `${(all.closer * 100).toFixed(0)}%`} of prices.
            </p>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Who was closest, by source and sport</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Set</th><th className="px-3 py-2 text-right">Prices</th><th className="px-3 py-2 text-right">DraftKings Brier</th><th className="px-3 py-2 text-right">Exchange Brier</th><th className="px-3 py-2 text-right">Exchange better by (per 1000)</th><th className="px-3 py-2 text-right">Kalshi Brier</th><th className="px-3 py-2 text-right">DraftKings on the same</th></tr></thead>
                  <tbody className="font-mono">
                    {[["All sports", obs] as const, ...sports.map((s) => [SPORT[s] ?? s, obs.filter((o) => o.sport === s)] as const)].map(([name, set]) => {
                      const a = versus(set, (o) => o.x);
                      const k = versus(set, (o) => o.ks);
                      return (
                        <tr key={name} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground">{name}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{a.n}</td>
                          <td className="px-3 py-1.5 text-right">{a.n ? f4(a.dkB) : "–"}</td>
                          <td className="px-3 py-1.5 text-right">{a.n ? f4(a.srcB) : "–"}</td>
                          <td className={`px-3 py-1.5 text-right ${a.n ? (a.edge > 0 ? "text-up" : "text-down") : ""}`}>{a.n ? (a.edge * 1000).toFixed(2) : "–"}</td>
                          <td className="px-3 py-1.5 text-right">{k.n ? f4(k.srcB) : "–"} <span className="text-muted">({k.n})</span></td>
                          <td className="px-3 py-1.5 text-right text-muted">{k.n ? f4(k.dkB) : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Kalshi is scored only on the prices it listed, so its row is compared with DraftKings on those same prices ({kal.n} of {obs.length}).</p>
            </section>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">When the exchange drifts from DraftKings</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">How far apart</th><th className="px-3 py-2 text-right">Prices</th><th className="px-3 py-2 text-right">Exchange closer</th><th className="px-3 py-2 text-right">DraftKings Brier</th><th className="px-3 py-2 text-right">Exchange Brier</th></tr></thead>
                  <tbody className="font-mono">
                    {bucketRows.map((b) => (
                      <tr key={b.name} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">{b.name}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{b.n}</td>
                        <td className="px-3 py-1.5 text-right">{b.closer == null ? "–" : `${(b.closer * 100).toFixed(0)}%`}</td>
                        <td className="px-3 py-1.5 text-right">{b.n ? f4(b.dkB) : "–"}</td>
                        <td className={`px-3 py-1.5 text-right ${b.n ? (b.xB < b.dkB ? "text-up" : "text-down") : ""}`}>{b.n ? f4(b.xB) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4 className="mb-1 mt-4 text-xs font-semibold text-foreground">Were the sharp traders behind the move? (prices 1¢ or more from DraftKings)</h4>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Who pushed the price</th><th className="px-3 py-2 text-right">Prices</th><th className="px-3 py-2 text-right">Exchange closer</th><th className="px-3 py-2 text-right">DraftKings Brier</th><th className="px-3 py-2 text-right">Exchange Brier</th></tr></thead>
                  <tbody className="font-mono">
                    {sharpSets.map(([name, set]) => (
                      <tr key={name} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">{name}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{set.length}</td>
                        <td className="px-3 py-1.5 text-right">{set.length ? `${((set.filter((o) => Math.abs(o.x! - o.y) < Math.abs(o.dk - o.y)).length / set.length) * 100).toFixed(0)}%` : "–"}</td>
                        <td className="px-3 py-1.5 text-right">{set.length ? f4(mean(set.map((o) => brier(o.dk, o.y)))) : "–"}</td>
                        <td className="px-3 py-1.5 text-right">{set.length ? f4(mean(set.map((o) => brier(o.x!, o.y)))) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                &ldquo;Sharp&rdquo; traders are those whose takes have earned a reputation for beating the close (a taker reputation of 0.3 or more in that sport). The question this answers: when the exchange disagreed with DraftKings, was it right more often when they were the ones moving it?
              </p>
              <p className="mt-3 text-xs text-foreground">
                Does the gap carry information beyond DraftKings&rsquo; own price? Regressing what happened (less DraftKings&rsquo; price) on the exchange&rsquo;s gap from DraftKings gives a slope of{" "}
                <span className="font-mono font-semibold">{slope == null ? "–" : slope.toFixed(2)}</span>{slopeSe != null && <span className="font-mono text-muted"> ± {(1.96 * slopeSe).toFixed(2)}</span>}. A slope near 0 means DraftKings already said it all and the
                exchange&rsquo;s drift is noise; near 1 means the exchange&rsquo;s price is the better one; negative means it moved the wrong way.
              </p>
            </section>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Game by game (newest first)</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Line</th><th className="px-3 py-2 text-right">DraftKings</th><th className="px-3 py-2 text-right">Exchange</th><th className="px-3 py-2 text-right">Kalshi</th><th className="px-3 py-2 text-right">Sharp net</th><th className="px-3 py-2 text-right">Happened</th></tr></thead>
                  <tbody className="font-mono">
                    {gameRows.flatMap((r) =>
                      r.closing!.lines.map(([kind, line], i) => {
                        const c = r.closing!;
                        const x = c.x?.[i] ?? null;
                        const y = c.y[i];
                        const better = x != null && y !== 0.5 ? Math.abs(x - y) < Math.abs(c.dk[i] - y) : null;
                        return (
                          <tr key={`${r.id}-${i}`} className="border-t border-border">
                            {i === 0 ? <td rowSpan={c.lines.length} className="px-3 py-1.5 align-top font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[r.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(r.id)}`} className="hover:text-accent">{r.away.abbr} @ {r.home.abbr}</Link><span className="ml-2 text-muted">{r.away_score}-{r.home_score}</span></td> : null}
                            <td className="px-3 py-1.5 font-sans">{kind === "ml" ? `${r.home.abbr} ML` : kind === "spread" ? `${r.home.abbr} ${line > 0 ? "+" : ""}${line}` : `Over ${line}`}</td>
                            <td className="px-3 py-1.5 text-right">{c1(c.dk[i])}</td>
                            <td className={`px-3 py-1.5 text-right ${better == null ? "text-muted" : better ? "text-up" : "text-down"}`}>{c1(x)}</td>
                            <td className="px-3 py-1.5 text-right text-muted">{c1(c.ks?.[i])}</td>
                            <td className="px-3 py-1.5 text-right text-muted">{c.sharp?.[i] ? (c.sharp[i] > 0 ? "+" : "") + c.sharp[i] : "–"}</td>
                            <td className="px-3 py-1.5 text-right">{y === 1 ? "yes" : y === 0 ? "no" : "push"}</td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Green in the Exchange column means the exchange was closer to what happened than DraftKings was; red means further. Sharp net is how many contracts reputed-sharp takers bought (+) or sold (−) on that line.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
