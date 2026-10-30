import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getDiscoveries, getExchange, type Discovery } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const f1 = (n: number) => n.toFixed(1);
// expected home margin as a spread: a positive margin is a favourite, written with a minus sign
const spreadText = (m: number, d = 1) => `${m > 0 ? "-" : "+"}${Math.abs(m).toFixed(d)}`;

export default async function DiscoveryPage() {
  const [rows, { meta }] = await Promise.all([getDiscoveries(), getExchange()]);
  const usable = rows.filter((r) => r.internal && r.seed);
  const err = (r: Discovery, which: "seed" | "internal", dim: 0 | 1) => Math.abs((which === "seed" ? r.seed! : r.internal!)[dim] - r.dk[dim]);
  const stat = (set: Discovery[]) => {
    const n = set.length;
    if (!n) return null;
    const mean = (f: (r: Discovery) => number) => set.reduce((a, r) => a + f(r), 0) / n;
    return {
      n, seedM: mean((r) => err(r, "seed", 0)), intM: mean((r) => err(r, "internal", 0)), seedT: mean((r) => err(r, "seed", 1)), intT: mean((r) => err(r, "internal", 1)),
      better: set.filter((r) => err(r, "internal", 0) + err(r, "internal", 1) / 3 < err(r, "seed", 0) + err(r, "seed", 1) / 3).length,
    };
  };
  const all = stat(usable);
  const sportsSeen = [...new Set(usable.map((r) => r.sport))];
  const bySport = sportsSeen.map((sp) => [sp, stat(usable.filter((r) => r.sport === sp))] as const);
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="discovery" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Line discovery: how close does the exchange get before DraftKings posts?</h2>
        <p className="mb-5 max-w-3xl text-xs leading-relaxed text-muted">
          When DraftKings has not priced a game, the syndicates make the line themselves. It opens at what the rating models agree on, then every quote and trade moves it. When DraftKings
          finally posts, this page compares three numbers for the expected margin and total: where the line <em>opened</em>, where trading had <em>moved</em> it, and what DraftKings <em>posted</em>.
          If trading helps, the moved line should be closer to DraftKings than the opening line.
        </p>

        {!all ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            Nothing to compare yet. A game shows up here the moment DraftKings posts a line on a game the syndicates had already been trading; the first few usually arrive within a day or two.
          </p>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Games compared", String(all.n)],
                ["Margin miss: opening → moved", `${f1(all.seedM)} → ${f1(all.intM)} pts`],
                ["Total miss: opening → moved", `${f1(all.seedT)} → ${f1(all.intT)} pts`],
                ["Trading got closer", `${all.better} of ${all.n} games`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
              ))}
            </div>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">By sport</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Sport</th><th className="px-3 py-2 text-right">Games</th><th className="px-3 py-2 text-right">Margin miss: opened</th><th className="px-3 py-2 text-right">Moved</th><th className="px-3 py-2 text-right">Total miss: opened</th><th className="px-3 py-2 text-right">Moved</th><th className="px-3 py-2 text-right">Trading closer</th></tr></thead>
                  <tbody className="font-mono">
                    {bySport.map(([sp, s]) => s && (
                      <tr key={sp} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground">{SPORT[sp] ?? sp}</td>
                        <td className="px-3 py-1.5 text-right">{s.n}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{f1(s.seedM)}</td>
                        <td className={`px-3 py-1.5 text-right ${s.intM < s.seedM ? "text-up" : "text-down"}`}>{f1(s.intM)}</td>
                        <td className="px-3 py-1.5 text-right text-muted">{f1(s.seedT)}</td>
                        <td className={`px-3 py-1.5 text-right ${s.intT < s.seedT ? "text-up" : "text-down"}`}>{f1(s.intT)}</td>
                        <td className="px-3 py-1.5 text-right">{s.better}/{s.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Game by game</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="bg-surface text-left text-muted">
                    <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">DraftKings posted</th><th className="px-3 py-2 text-right">Rounds traded</th><th className="px-3 py-2 text-right">Margin: opened</th><th className="px-3 py-2 text-right">moved</th><th className="px-3 py-2 text-right">DraftKings</th><th className="px-3 py-2 text-right">Total: opened</th><th className="px-3 py-2 text-right">moved</th><th className="px-3 py-2 text-right">DraftKings</th></tr>
                  </thead>
                  <tbody className="font-mono">
                    {usable.slice(0, 60).map((r) => {
                      const dm = r.dk[0], im = r.internal![0], sm = r.seed![0];
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 text-[10px] text-muted">{SPORT[r.sport]}</span><Link href={`/syndicates/games/${encodeURIComponent(r.id)}`} className="hover:text-accent">{r.teams}</Link></td>
                          <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={r.found} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {r.hours_before.toFixed(0)}h before kickoff</td>
                          <td className="px-3 py-1.5 text-right text-muted">{r.rounds}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{spreadText(sm)}</td>
                          <td className={`px-3 py-1.5 text-right ${Math.abs(im - dm) < Math.abs(sm - dm) ? "text-up" : "text-down"}`}>{spreadText(im)}</td>
                          <td className="px-3 py-1.5 text-right text-foreground">{spreadText(dm)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{f1(r.seed![1])}</td>
                          <td className={`px-3 py-1.5 text-right ${Math.abs(r.internal![1] - r.dk[1]) < Math.abs(r.seed![1] - r.dk[1]) ? "text-up" : "text-down"}`}>{f1(r.internal![1])}</td>
                          <td className="px-3 py-1.5 text-right text-foreground">{f1(r.dk[1])}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">Margins are written as spreads for the home team (−3.5 means a 3.5 point favourite); green means trading moved the line closer to DraftKings, red means further. The DraftKings column is its expected margin and total fitted from the posted lines and prices, so it can differ slightly from the printed number.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
