import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import LocalDateTime from "@/components/LocalDateTime";
import { getPanelBoard, getPanelUpcoming, type Nums, type Score } from "@/lib/panelBoard";
import { equityOf, getExchange } from "@/lib/syndicates";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const f = (v: number | null, d = 2) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d));
const sgn = (v: number | null, d = 2) => (v == null || Number.isNaN(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
const cell = (s: Score) => (s.n ? <><span className="text-foreground">{f(s.mae)}</span> <span className="text-muted">({sgn(s.bias, 1)}, n {s.n})</span></> : <span className="text-muted">–</span>);

type Calib = Record<string, { n: number; miss?: number; t_miss?: number }>;

// a margin is the home team's expected winning margin; a spread writes it the other way round (a favourite is -x)
const spreadText = (m: number) => `${m > 0 ? "-" : "+"}${Math.abs(m).toFixed(1)}`;
const diff = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

export default async function PanelPage({ searchParams }: { searchParams: Promise<{ by?: string; all?: string }> }) {
  const sp = await searchParams;
  const [board, upcoming, { members, syndicates, meta }, { data: rp }] = await Promise.all([
    getPanelBoard(),
    getPanelUpcoming(),
    getExchange(),
    supabase.from("ex_meta").select("value").eq("key", "panel").maybeSingle(),
  ]);
  const payload = (rp?.value ?? null) as { asof?: string; calib?: Calib } | null;
  const panel = members.filter((m) => m.syndicate_id === "pan").sort((a, b) => a.id.localeCompare(b.id));
  const syn = syndicates.find((s) => s.id === "pan");
  const pair = Object.fromEntries(board.pairs.map((p) => [p.id, p]));
  const best = (rows: { key: string; s: Score }[]) => {
    const ok = rows.filter((r) => r.s.n >= 5 && r.s.mae != null);
    return ok.length ? ok.reduce((a, b) => (b.s.mae! < a.s.mae! ? b : a)).key : null;
  };
  const bestOpen = best(board.open.filter((r) => !["seed", "line"].includes(r.key)).map((r) => ({ key: r.key, s: r.margin })));
  const bestClose = best(board.close.filter((r) => r.key !== "dk").map((r) => ({ key: r.key, s: r.dkM })));
  const bestRes = best(board.close.filter((r) => r.key !== "dk").map((r) => ({ key: r.key, s: r.resM })));

  const by = sp.by === "systems" || sp.by === "total" ? sp.by : "line";
  const sys3 = ["kenpom", "torvik", "evanmiya"] as const;
  const mOf = (n: Nums | undefined) => (n ? n[0] : null);
  const ranked = upcoming.rows
    .map((r) => {
      const ms = sys3.map((k) => mOf(r.nums[k])).filter((x): x is number => x != null);
      const avg = mOf(r.nums.avg);
      return {
        ...r,
        gapLine: avg != null ? avg - r.m : null,
        range: ms.length >= 2 ? Math.max(...ms) - Math.min(...ms) : null,
        gapTotal: r.nums.avg?.[1] != null ? r.nums.avg[1]! - r.t : null,
      };
    })
    .filter((r) => (by === "systems" ? r.range != null : by === "total" ? r.gapTotal != null : r.gapLine != null))
    .sort((a, b) => Math.abs((by === "systems" ? b.range : by === "total" ? b.gapTotal : b.gapLine) ?? 0) - Math.abs((by === "systems" ? a.range : by === "total" ? a.gapTotal : a.gapLine) ?? 0))
    .slice(0, 30);
  const shown = sp.all === "1" ? board.openGames : board.openGames.slice(0, 40);
  const pill = (href: string, text: string, on: boolean) => (
    <Link href={href} className={`rounded px-2.5 py-1 text-[11px] ${on ? "bg-accent text-background" : "border border-border text-muted hover:text-foreground"}`}>{text}</Link>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="panel" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Ratings Panel: which outside rating system is closest?</h2>
        <p className="mb-5 max-w-3xl text-xs leading-relaxed text-muted">
          {syn?.tagline ?? "College basketball market makers that quote from KenPom, Torvik and EvanMiya."} Each system&rsquo;s own number for a game is saved when DraftKings first posts a line on a game the exchange
          was already making a line on, and again when the game finishes. This page scores them against both. A smaller miss is better; the bracket shows the average bias (positive means the system had the home
          team too strong) and the number of games. Profit and loss is a poorer test of a rating, because it also depends on how wide a trader quotes.
        </p>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Games vs DraftKings' first line", String(board.games.open)],
            ["Games vs close and result", String(board.games.close)],
            ["Ratings as of", board.asof ?? payload?.asof ?? "–"],
            ["Panel equity", `${panel.reduce((a, m) => a + equityOf(m), 0).toFixed(0)} of ${syn?.start_units?.toLocaleString() ?? "–"}`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
          ))}
        </div>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Biggest differences on games on offer now</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">
            The panel&rsquo;s numbers against the current line, which is DraftKings&rsquo; if it has posted and the exchange&rsquo;s own if not. Each figure is the spread, then how far the system sits from the line in points
            (+ means it has the home team stronger than the line). Updated each round{upcoming.ts ? <> · <LocalDateTime iso={upcoming.ts} options={{ hour: "numeric", minute: "2-digit" }} /></> : null}.
          </p>
          <div className="mb-2 flex flex-wrap gap-2">
            {pill("/syndicates/panel", "Panel average vs the line", by === "line")}
            {pill("/syndicates/panel?by=systems", "Systems disagree most", by === "systems")}
            {pill("/syndicates/panel?by=total", "Total vs the line", by === "total")}
          </div>
          {ranked.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">Nothing yet: this fills after the next exchange round.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-[11px]">
                <thead className="bg-surface text-left text-muted">
                  <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Line</th><th className="px-3 py-2">Panel average</th><th className="px-3 py-2">KenPom</th><th className="px-3 py-2">Torvik</th><th className="px-3 py-2">EvanMiya</th><th className="px-3 py-2 text-right">Systems range</th></tr>
                </thead>
                <tbody className="font-mono">
                  {ranked.map((r) => (
                    <tr key={r.id} className="border-t border-border align-top">
                      <td className="px-3 py-1 font-sans text-foreground">
                        <Link href={`/syndicates/games/${encodeURIComponent(r.id)}`} className="hover:text-accent">{r.teams}</Link>
                        <div className="text-[10px] text-muted"><LocalDateTime iso={r.start} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></div>
                      </td>
                      <td className="px-3 py-1">
                        {spreadText(r.m)}
                        <div className="text-[10px] text-muted">{r.src === "dk" ? "DraftKings" : "exchange line"} · total {r.t.toFixed(1)}</div>
                      </td>
                      {(["avg", ...sys3] as const).map((k) => {
                        const n = r.nums[k];
                        return (
                          <td key={k} className="px-3 py-1">
                            {n ? <>{spreadText(n[0])} <span className={Math.abs(n[0] - r.m) >= 3 ? "text-accent" : "text-muted"}>({diff(n[0] - r.m)})</span>{n[1] != null && <div className="text-[10px] text-muted">total {n[1].toFixed(1)} ({diff(n[1] - r.t)})</div>}</> : <span className="text-muted">–</span>}
                          </td>
                        );
                      })}
                      <td className="px-3 py-1 text-right">{r.range != null ? `${r.range.toFixed(1)} pts` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">When DraftKings opened, game by game</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">
            Each game the exchange was making a line on before DraftKings posted: DraftKings&rsquo; first spread and total, then every source&rsquo;s number and its distance from DraftKings in points. The closest of the four
            rating numbers is highlighted. Older rows were filled in afterwards from the November 3 ratings, marked <span className="text-foreground">*</span>; newer rows are logged live at the moment DraftKings posts.
          </p>
          {shown.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">No openings with the panel&rsquo;s numbers yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[920px] text-[11px]">
                <thead className="bg-surface text-left text-muted">
                  <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">DraftKings opened</th><th className="px-3 py-2">Our opening seed</th><th className="px-3 py-2">Exchange when DK posted</th><th className="px-3 py-2">Panel average</th><th className="px-3 py-2">KenPom</th><th className="px-3 py-2">Torvik</th><th className="px-3 py-2">EvanMiya</th></tr>
                </thead>
                <tbody className="font-mono">
                  {shown.map((g) => {
                    const dm = g.dkSpread != null ? -g.dkSpread : g.dkM;
                    const dt = g.dkTotal ?? g.dkT;
                    const four = (["avg", ...sys3] as const).map((k) => [k, g.cells[k]] as const).filter(([, n]) => n);
                    const bestK = four.length ? four.reduce((a, b) => (Math.abs(b[1]![0] - dm) < Math.abs(a[1]![0] - dm) ? b : a))[0] : null;
                    return (
                      <tr key={g.id} className="border-t border-border align-top">
                        <td className="px-3 py-1 font-sans text-foreground">
                          <Link href={`/syndicates/games/${encodeURIComponent(g.id)}`} className="hover:text-accent">{g.teams}</Link>{g.backfilled && <span className="ml-1 text-muted" title="Filled in afterwards from the November 3 ratings">*</span>}
                          <div className="text-[10px] text-muted"><LocalDateTime iso={g.found} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {g.hours.toFixed(0)}h before</div>
                        </td>
                        <td className="px-3 py-1">{spreadText(dm)}<div className="text-[10px] text-muted">total {dt.toFixed(1)}</div></td>
                        {(["seed", "line", "avg", ...sys3] as const).map((k) => {
                          const n = g.cells[k];
                          return (
                            <td key={k} className="px-3 py-1">
                              {n ? <>{spreadText(n[0])} <span className={k === bestK ? "font-semibold text-accent" : "text-muted"}>({diff(n[0] - dm)})</span>{n[1] != null && <div className="text-[10px] text-muted">total {n[1].toFixed(1)} ({diff(n[1] - dt)})</div>}</> : <span className="text-muted">–</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {board.openGames.length > 40 && sp.all !== "1" && <p className="mt-2 text-[11px] text-muted"><Link href="/syndicates/panel?all=1" className="text-accent hover:underline">Show all {board.openGames.length} openings</Link></p>}
        </section>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Against DraftKings&rsquo; first line</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">Points of miss on the expected margin and total. The first two rows are the exchange itself: where the line opened and where trading had moved it. If trading with the panel helps, the second should beat the first.</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-[11px]">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Source</th><th className="px-3 py-2">Margin miss</th><th className="px-3 py-2">Total miss</th></tr></thead>
              <tbody className="font-mono">
                {board.open.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="px-3 py-1 font-sans text-foreground">{r.label}{r.key === bestOpen && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">closest</span>}</td>
                    <td className="px-3 py-1">{cell(r.margin)}</td>
                    <td className="px-3 py-1">{cell(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Against DraftKings&rsquo; close and the result</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">Every finished college basketball game since the panel started logging. The DraftKings row is its own closing line against the result: the bar a rating has to approach, and the best any of them is likely to do.</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[760px] text-[11px]">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Source</th><th className="px-3 py-2">Margin vs close</th><th className="px-3 py-2">Total vs close</th><th className="px-3 py-2">Margin vs result</th><th className="px-3 py-2">Total vs result</th></tr></thead>
              <tbody className="font-mono">
                {board.close.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="px-3 py-1 font-sans text-foreground">{r.label}{r.key === bestRes && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">closest to results</span>}{r.key === bestClose && r.key !== bestRes && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">closest to DK</span>}</td>
                    <td className="px-3 py-1">{cell(r.dkM)}</td>
                    <td className="px-3 py-1">{cell(r.dkT)}</td>
                    <td className="px-3 py-1">{cell(r.resM)}</td>
                    <td className="px-3 py-1">{cell(r.resT)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {payload?.calib && (
            <p className="mt-2 text-[11px] text-muted">
              For reference, when each system was fitted to DraftKings&rsquo; closing margin (on the October ratings, in sample): {Object.entries(payload.calib).filter(([, c]) => c.miss != null).map(([k, c]) => `${k} ${c.miss!.toFixed(2)} points over ${c.n} games`).join(", ")}.
            </p>
          )}
        </section>

        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold text-foreground">The traders</h3>
          <p className="mb-2 max-w-3xl text-[11px] text-muted">Each of the first three quotes from one system; the composites quote the average. &ldquo;Against each other&rdquo; is profit on settled trades between two panel traders, where only the rating system differs.</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-[11px]">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Trader</th><th className="px-3 py-2 text-right">Equity</th><th className="px-3 py-2 text-right">Realized</th><th className="px-3 py-2 text-right">Maker trades</th><th className="px-3 py-2 text-right">Maker CLV</th><th className="px-3 py-2 text-right">Against each other</th></tr></thead>
              <tbody className="font-mono">
                {panel.map((m) => {
                  const s = m.stats as unknown as Record<string, number>;
                  const clv = s.clv_maker_n ? (s.clv_maker_sum / s.clv_maker_n) * 100 : null;
                  const p = pair[m.id];
                  return (
                    <tr key={m.id} className="border-t border-border">
                      <td className="px-3 py-1 font-sans text-foreground"><Link href={`/syndicates/traders/${m.id}`} className="hover:text-accent">{m.name}</Link></td>
                      <td className="px-3 py-1 text-right">{equityOf(m).toFixed(0)}</td>
                      <td className={`px-3 py-1 text-right ${m.realized >= 0 ? "text-up" : "text-down"}`}>{sgn(m.realized, 1)}</td>
                      <td className="px-3 py-1 text-right">{s.n_maker ?? 0}</td>
                      <td className="px-3 py-1 text-right">{clv == null ? "–" : `${sgn(clv, 2)}¢`}</td>
                      <td className={`px-3 py-1 text-right ${p ? (p.pnl >= 0 ? "text-up" : "text-down") : "text-muted"}`}>{p ? `${sgn(p.pnl, 1)} on ${p.n} trades` : "none settled yet"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
