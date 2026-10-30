import { SyndicateHeader } from "@/components/SyndicateParts";
import { getClosings, getExchange } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const f4 = (n: number) => n.toFixed(4);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function corr(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 5) return null;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : null;
}

export default async function DisagreementPage() {
  const [closings, { syndicates, meta }] = await Promise.all([getClosings(), getExchange()]);
  // one observation per finished game's moneyline, main spread and main total: each syndicate's price, DraftKings' close, Kalshi, the exchange and what happened
  type Obs = { dk: number; y: number; x: number | null; ks: number | null; e: Record<string, number> };
  const obs: Obs[] = [];
  for (const r of closings) {
    const c = r.closing;
    if (!c || (c.src ?? "dk") !== "dk" || !c.e) continue;
    c.lines.forEach((_, i) => {
      const y = c.y[i];
      if (y == null || y === 0.5 || c.dk[i] == null) return;
      const e: Record<string, number> = {};
      for (const [sid, arr] of Object.entries(c.e ?? {})) if (arr[i] != null) e[sid] = arr[i];
      obs.push({ dk: c.dk[i], y, x: c.x?.[i] ?? null, ks: c.ks?.[i] ?? null, e });
    });
  }
  const ids = syndicates.filter((s) => obs.filter((o) => o.e[s.id] != null).length >= obs.length * 0.8 && s.engine !== "mm" && s.engine !== "ref").map((s) => s.id);
  const info = Object.fromEntries(syndicates.map((s) => [s.id, s]));
  const full = obs.filter((o) => ids.every((i) => o.e[i] != null));
  const dev = (id: string) => full.map((o) => o.e[id] - o.dk);
  const err = (id: string) => full.map((o) => o.e[id] - o.y);
  const cmat = ids.map((a) => ids.map((b) => (a === b ? 1 : corr(dev(a), dev(b)))));
  const avgOther = ids.map((_, i) => {
    const v = cmat[i].filter((x, j) => j !== i && x != null) as number[];
    return v.length ? mean(v) : null;
  });
  const brier = (p: number[], y: number[]) => mean(p.map((v, i) => (v - y[i]) ** 2));
  const ys = full.map((o) => o.y);
  const dk = full.map((o) => o.dk);
  const consensus = full.map((o) => mean(ids.map((i) => o.e[i])));
  const bDk = brier(dk, ys), bCons = brier(consensus, ys);
  const single = ids.map((i) => ({ i, b: brier(full.map((o) => o.e[i]), ys) })).sort((a, b) => a.b - b.b);
  const loo = ids.map((i) => {
    const rest = ids.filter((j) => j !== i);
    const p = full.map((o) => mean(rest.map((j) => o.e[j])));
    return { i, delta: brier(p, ys) - bCons }; // positive: the consensus gets worse without this group
  }).sort((a, b) => b.delta - a.delta);
  const sizeOf = (id: string) => mean(dev(id).map(Math.abs));
  const shade = (v: number | null) => (v == null ? undefined : { background: `rgba(${v >= 0 ? "59,130,246" : "239,68,68"},${(0.1 + 0.55 * Math.abs(v)).toFixed(2)})` });

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="disagreement" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Disagreement: do the groups hold different opinions, or the same one?</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          For a free market to work, the groups have to be wrong in different ways. Each cell is how closely two groups&rsquo; <em>opinions</em> move together, measured as each group&rsquo;s price minus DraftKings&rsquo; closing price on the same lines
          (moneyline, main spread and main total of every finished game). Near +1 (blue) means they push the price the same way, so they are one opinion counted twice. Near 0 means independent. Negative (red) means they disagree.
          {" "}{full.length ? `Built from ${full.length} prices on ${Math.round(full.length / 3)} finished games, so read it as a first look: it firms up as games finish.` : ""}
        </p>
        {full.length < 15 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">Not enough finished games with model prices yet.</p>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["DraftKings close Brier", f4(bDk)], ["Average of all groups", f4(bCons)], ["Best single group", `${info[single[0].i]?.name} ${f4(single[0].b)}`], ["Most similar pair", (() => {
                let best: [number, string] = [-2, ""];
                ids.forEach((a, i) => ids.forEach((b, j) => { if (j > i && cmat[i][j] != null && (cmat[i][j] as number) > best[0]) best = [cmat[i][j] as number, `${info[a]?.name.split(" ")[0]} + ${info[b]?.name.split(" ")[0]} ${(best[0] = cmat[i][j] as number).toFixed(2)}`]; }));
                return best[1] || "–";
              })()]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-sm font-semibold text-foreground">{v}</p></div>
              ))}
            </div>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">How alike the opinions are</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-surface text-muted">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium">Group</th>
                      <th className="px-2 py-2 text-right font-medium" title="Average distance of its price from DraftKings' close, in cents">Off DK by</th>
                      <th className="px-2 py-2 text-right font-medium" title="Average correlation with every other group">Alike others</th>
                      {ids.map((i) => <th key={i} className="px-1 py-2 text-center font-medium" title={info[i]?.name}>{info[i]?.name.split(" ").map((w) => w[0]).join("")}</th>)}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {ids.map((a, i) => (
                      <tr key={a} className="border-t border-border">
                        <td className="whitespace-nowrap px-2 py-1 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: info[a]?.color }} />{info[a]?.name}</td>
                        <td className="px-2 py-1 text-right text-muted">{(sizeOf(a) * 100).toFixed(1)}¢</td>
                        <td className="px-2 py-1 text-right">{avgOther[i] == null ? "–" : avgOther[i]!.toFixed(2)}</td>
                        {ids.map((b, j) => <td key={b} style={a === b ? undefined : shade(cmat[i][j])} className="px-1 py-1 text-center">{a === b ? "·" : cmat[i][j] == null ? "–" : (cmat[i][j] as number).toFixed(2)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-muted">A group whose &ldquo;Off DK by&rdquo; is near zero has no opinion of its own (it is following the price). A group that is both far off DraftKings and alike others is a crowd; one that is far off and not alike anyone is an independent view, which is what a free market needs.</p>
            </section>

            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold text-foreground">What each group adds to the average</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full max-w-2xl text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Group</th><th className="px-3 py-2 text-right">Own Brier</th><th className="px-3 py-2 text-right">Average gets worse without it by (per 1000)</th></tr></thead>
                  <tbody className="font-mono">
                    {loo.map((r) => (
                      <tr key={r.i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: info[r.i]?.color }} />{info[r.i]?.name}</td>
                        <td className="px-3 py-1.5 text-right">{f4(single.find((s) => s.i === r.i)!.b)}</td>
                        <td className={`px-3 py-1.5 text-right ${r.delta > 0 ? "text-up" : "text-down"}`}>{(r.delta * 1000).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 max-w-3xl text-[11px] text-muted">Positive means the equal-weight average of the groups predicts the results worse when that group is left out, so it is adding something the others do not have. Negative means the average is better without it. Within this few games it is noisy; the sign matters more than the size.</p>
              <p className="mt-2 text-[11px] text-muted">Sorted from the group that adds the most. Each group&rsquo;s own Brier is shown for comparison with DraftKings&rsquo; {f4(bDk)} and the average&rsquo;s {f4(bCons)}.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
