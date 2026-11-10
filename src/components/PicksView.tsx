import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { getPicks, type Pick } from "@/lib/syndicates";

const sg = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-muted");
const NAME: Record<string, string> = { cbb_movement: "CBB movement model" };

// The movement model's strict walk-forward test (python -m cbb_model.movement evaluate): trained on earlier seasons only, then every game of the test season bet at the OPENING number on the side the model said the line would move toward,
// at -110. "Top 10%" and "top 20%" are the games with the biggest predicted moves in that season. Tier A below is about the top 10% of what the board prices at once, tier B about the top 20%.
const BENCH: { season: string; train: string; rows: { market: string; top: string; n: number; win: number; roi: number; clv: number }[] }[] = [
  { season: "2025", train: "trained on 2023 and 2024", rows: [
    { market: "Totals", top: "Top 10%", n: 569, win: 55.4, roi: 5.7, clv: 1.78 }, { market: "Totals", top: "Top 20%", n: 1138, win: 56.0, roi: 6.9, clv: 1.57 },
    { market: "Spreads", top: "Top 10%", n: 569, win: 58.7, roi: 12.1, clv: 1.59 }, { market: "Spreads", top: "Top 20%", n: 1138, win: 55.2, roi: 5.4, clv: 1.07 },
  ] },
  { season: "2024", train: "trained on 2023 only", rows: [
    { market: "Totals", top: "Top 10%", n: 576, win: 52.4, roi: 0.1, clv: 1.23 }, { market: "Totals", top: "Top 20%", n: 1151, win: 52.4, roi: 0.0, clv: 1.05 },
    { market: "Spreads", top: "Top 10%", n: 576, win: 51.7, roi: -1.2, clv: 1.26 }, { market: "Spreads", top: "Top 20%", n: 1151, win: 52.3, roi: -0.2, clv: 0.93 },
  ] },
];

/** The Monday that starts the US-Eastern week (Monday to Sunday) a game started in, as a YYYY-MM-DD string. */
function weekOf(iso: string): string {
  const et = new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = (et.getDay() + 6) % 7; // Monday = 0
  et.setDate(et.getDate() - day);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

function summary(ps: Pick[]) {
  const dec = ps.filter((p) => p.result !== 0);
  const w = dec.filter((p) => (p.result ?? 0) > 0).length;
  const flat = ps.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const scaled = ps.reduce((a, p) => a + (p.pnl_scaled ?? 0), 0);
  const stake = ps.reduce((a, p) => a + p.units_scaled, 0);
  const clv = ps.length ? ps.reduce((a, p) => a + (p.clv ?? 0), 0) / ps.length : 0;
  return {
    n: ps.length, w, l: dec.length - w, push: ps.length - dec.length, flat, roi: ps.length ? flat / ps.length : 0, scaled, sroi: stake ? scaled / stake : 0,
    clv, clvPos: ps.length ? ps.filter((p) => (p.clv ?? 0) > 0).length / ps.length : 0,
  };
}

function Row({ label, ps }: { label: React.ReactNode; ps: Pick[] }) {
  const s = summary(ps);
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-1.5 font-sans text-foreground">{label}</td>
      <td className="px-3 py-1.5 text-right text-muted">{s.n}</td>
      <td className="px-3 py-1.5 text-right">{s.w}-{s.l}{s.push ? `-${s.push}` : ""}</td>
      <td className={`px-3 py-1.5 text-right ${tone(s.flat)}`}>{sg(s.flat)}</td>
      <td className={`px-3 py-1.5 text-right ${tone(s.roi)}`}>{sg(s.roi * 100, 1)}%</td>
      <td className={`px-3 py-1.5 text-right ${tone(s.scaled)}`}>{sg(s.scaled)}</td>
      <td className={`px-3 py-1.5 text-right ${tone(s.sroi)}`}>{sg(s.sroi * 100, 1)}%</td>
      <td className={`px-3 py-1.5 text-right ${tone(s.clv)}`}>{sg(s.clv)}</td>
      <td className="px-3 py-1.5 text-right text-muted">{(s.clvPos * 100).toFixed(0)}%</td>
    </tr>
  );
}

const HEAD = (first: string) => (
  <thead className="bg-surface text-left text-muted">
    <tr>
      <th className="px-3 py-2">{first}</th>
      <th className="px-3 py-2 text-right">Picks</th>
      <th className="px-3 py-2 text-right" title="Wins, losses and pushes at the number taken">W-L-P</th>
      <th className="px-3 py-2 text-right" title="Flat staking: one unit on every pick, at -110">Flat units</th>
      <th className="px-3 py-2 text-right">Flat ROI</th>
      <th className="px-3 py-2 text-right" title="Scaled staking: half a unit to two, in proportion to the predicted move">Scaled units</th>
      <th className="px-3 py-2 text-right">Scaled ROI</th>
      <th className="px-3 py-2 text-right" title="Average closing-line value, in points: the closing number against the number taken">Avg CLV pts</th>
      <th className="px-3 py-2 text-right" title="Share of picks that closed at a better number than they were taken at">Beat close</th>
    </tr>
  </thead>
);

/** The paper-picks scoreboard: open picks, the weekly record, and each kind of pick on its own. Shown on the Desk's Picks page. */
export default async function PicksView() {
  const { open, done, boardAt, live, liveAt } = await getPicks();
  const stale = !boardAt || Date.now() - new Date(boardAt).getTime() > 3 * 3600000;
  const total = summary(done);
  const weeks = [...new Set(done.map((p) => weekOf(p.start)))].sort().reverse();
  const tiers = ["A", "B"];
  const kinds: ["spread" | "total", string][] = [["spread", "Spread"], ["total", "Total"]];
  const recent = [...done].sort((a, b) => (b.graded ?? "").localeCompare(a.graded ?? "")).slice(0, 40);
  const isLive = (p: Pick) => live[p.id]?.side === p.side;
  const upcoming = [...open].filter((p) => new Date(p.start).getTime() > Date.now()).sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.start.localeCompare(b.start));
  const liveNow = upcoming.filter(isLive);
  const nA = liveNow.filter((p) => live[p.id].tier === "A").length, nB = liveNow.filter((p) => live[p.id].tier === "B").length;
  const liveStale = !liveAt || Date.now() - new Date(liveAt).getTime() > 20 * 60000;
  const sideText = (p: Pick) => (p.kind === "spread" ? `${p.side === "home" ? p.home : p.away} ${p.side === "home" ? (p.line > 0 ? `-${p.line}` : `+${Math.abs(p.line)}`) : p.line > 0 ? `+${p.line}` : `-${Math.abs(p.line)}`}` : `${p.side === "over" ? "Over" : "Under"} ${p.line}`);
  return (
    <>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Paper picks</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          What the models would play, logged at the number they were first playable and graded afterwards. Nothing is bet. Each kind of pick is tracked on its own so the record shows which ones work.
          The first source is the college basketball movement model, which predicts how far each line will move before the close: a pick is the side the line should move toward, taken at the number up now.
          Tiers come from its walk-forward test: A is the top few percent of predicted moves, B the next tranche. Flat staking is one unit on every pick (the number to judge by); scaled staking is half a unit to two in proportion to the predicted move, to see whether the model knows which picks are better. Prices are taken at -110.
        </p>
        {stale && (
          <p className="mb-4 rounded-lg bg-warn/15 px-3 py-2 text-xs text-warn">
            The college basketball board last refreshed {boardAt ? <LocalDateTime iso={boardAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> : "never"}. New picks are only made from a board less than three hours old, so none are being logged until its refresh job runs again.
          </p>
        )}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Flagged now", liveNow.length ? `${nA} A, ${nB} B` : "none"],
            ["Graded", String(done.length)],
            ["Flat record", done.length ? `${total.w}-${total.l}${total.push ? `-${total.push}` : ""}` : "–"],
            ["Flat ROI", done.length ? `${sg(total.roi * 100, 1)}%` : "–"],
            ["Avg CLV (points)", done.length ? sg(total.clv) : "–"],
          ].map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>)}
        </div>

        <h3 className="mb-1 text-sm font-semibold text-foreground">Flagged now: plays that meet the backtested criteria</h3>
        <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
          A play shows here when the movement model expects the line to move at least a set amount before the close (totals 1.0 point or more, spreads 0.5 or more, bigger for tier A) and the game is among the biggest predicted moves on today&rsquo;s board:
          tier A is about the top 7 to 10%, tier B about the top 20%, the same cuts as the benchmark table below. The play is the side the line should move toward, at the number up now, so it is only worth taking at or near that number, before the move. The{" "}
          <Link href="/syndicates/mov" className="text-accent hover:underline">Open Movers</Link> firm on the exchange trades these same flagged markets. A play marked &ldquo;No longer flagged&rdquo; was flagged earlier but the line has since moved or the model has changed its mind: it is kept in the log, but it is not a play to take now.
        </p>
        {upcoming.length === 0 ? (
          <p className="mb-6 rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">Nothing flagged right now. Plays appear when a game&rsquo;s opening line has a big enough expected move.</p>
        ) : (
          <div className="mb-6 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Starts</th><th className="px-3 py-2">Pick</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Tier</th><th className="px-3 py-2 text-right">Predicted move</th><th className="px-3 py-2 text-right">Scaled units</th><th className="px-3 py-2">Logged</th></tr></thead>
              <tbody className="font-mono">
                {upcoming.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground">{p.teams}<span className="block text-[10px] text-muted">{NAME[p.source] ?? p.source}</span></td>
                    <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={p.start} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></td>
                    <td className="px-3 py-1.5 font-sans text-foreground">{sideText(p)}<span className="block text-[10px] text-muted">{p.kind === "spread" ? "spread" : "total"}{p.open != null ? `, opened ${p.open}` : ""}</span></td>
                    <td className="px-3 py-1.5 font-sans">
                      {isLive(p) && !liveStale ? <span className="font-semibold text-up">Live now</span> : <span className="text-muted">{liveStale ? "Unknown" : "No longer flagged"}</span>}
                      {isLive(p) && live[p.id].line !== p.line && <span className="block text-[10px] text-muted">now {sideText({ ...p, line: live[p.id].line })}</span>}
                    </td>
                    <td className="px-3 py-1.5 font-sans text-muted">{isLive(p) ? live[p.id].tier : p.tier}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{Math.abs(p.rem).toFixed(1)} pts</td>
                    <td className="px-3 py-1.5 text-right text-muted">{p.units_scaled.toFixed(2)}</td>
                    <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={p.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="mb-1 text-sm font-semibold text-foreground">Backtest benchmark: what the top tiers did out of sample</h3>
        <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
          Each season was predicted by a model trained only on earlier seasons, then bet at the opening number. Win rate and ROI are at -110 (break-even is 52.4%). CLV is how many points the line then moved toward the play. The first season on live data is what the
          record below is for: 2025, with two seasons of training, was clearly profitable; 2024, with one season of training, made no money on results even though the line did move its way.
        </p>
        <div className="mb-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] font-mono text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Test season</th><th className="px-3 py-2">Market</th><th className="px-3 py-2">Biggest predicted moves</th><th className="px-3 py-2 text-right">Games</th><th className="px-3 py-2 text-right">Win rate</th><th className="px-3 py-2 text-right">ROI</th><th className="px-3 py-2 text-right">CLV pts</th></tr></thead>
            <tbody>
              {BENCH.flatMap((b) => b.rows.map((r, i) => (
                <tr key={`${b.season}${r.market}${r.top}`} className="border-t border-border">
                  <td className="px-3 py-1.5 font-sans text-foreground">{i === 0 ? <>{b.season}<span className="block text-[10px] text-muted">{b.train}</span></> : ""}</td>
                  <td className="px-3 py-1.5 font-sans text-foreground">{r.market}</td>
                  <td className="px-3 py-1.5 font-sans text-muted">{r.top}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{r.n.toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-right ${r.win > 52.4 ? "text-up" : "text-muted"}`}>{r.win.toFixed(1)}%</td>
                  <td className={`px-3 py-1.5 text-right ${tone(r.roi)}`}>{sg(r.roi, 1)}%</td>
                  <td className={`px-3 py-1.5 text-right ${tone(r.clv)}`}>{sg(r.clv)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>

        <h3 className="mb-2 text-sm font-semibold text-foreground">By week (Monday to Sunday, US Eastern, by game start)</h3>
        {done.length === 0 ? (
          <p className="mb-6 rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">Nothing graded yet. Picks are graded after their game finishes and its closing number is saved.</p>
        ) : (
          <div className="mb-6 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[820px] font-mono text-xs">
              {HEAD("Week starting")}
              <tbody>
                {weeks.map((w) => <Row key={w} label={w} ps={done.filter((p) => weekOf(p.start) === w)} />)}
                <Row label={<span className="font-semibold">All weeks</span>} ps={done} />
              </tbody>
            </table>
          </div>
        )}

        {done.length > 0 && (
          <>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Live record by market and tier</h3>
            <div className="mb-6 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] font-mono text-xs">
                {HEAD("Market")}
                <tbody>
                  {kinds.flatMap(([k, name]) => tiers.map((t) => <Row key={`${k}${t}`} label={`${name}, tier ${t}`} ps={done.filter((p) => p.kind === k && p.tier === t)} />))}
                </tbody>
              </table>
            </div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Recent graded picks</h3>
            <div className="mb-6 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Pick</th><th className="px-3 py-2 text-right">Closed</th><th className="px-3 py-2 text-right">CLV pts</th><th className="px-3 py-2 text-right">Result</th><th className="px-3 py-2 text-right">Flat units</th></tr></thead>
                <tbody className="font-mono">
                  {recent.map((p) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">{p.teams}</td>
                      <td className="px-3 py-1.5 font-sans text-foreground">{sideText(p)} <span className="text-muted">tier {p.tier}</span></td>
                      <td className="px-3 py-1.5 text-right text-muted">{p.kind === "spread" && p.close != null ? (p.close > 0 ? `-${p.close}` : `+${Math.abs(p.close)}`) : p.close}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(p.clv ?? 0)}`}>{sg(p.clv ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{(p.result ?? 0) > 0 ? "won" : (p.result ?? 0) < 0 ? "lost" : "push"} ({p.actual})</td>
                      <td className={`px-3 py-1.5 text-right ${tone(p.pnl ?? 0)}`}>{sg(p.pnl ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="max-w-3xl text-[11px] text-muted">
          Closing-line value is measured in points against ESPN&rsquo;s closing number, and it counts only the movement after the pick was logged. A result is graded at the number taken, pushes returned. Past results of the model were tested out of sample before this page began logging live ones.
        </p>
      </main>
    </>
  );
}
