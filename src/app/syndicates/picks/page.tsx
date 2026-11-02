import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getPicks, type Pick } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const sg = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-muted");
const NAME: Record<string, string> = { cbb_movement: "CBB movement model" };

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

export default async function PicksPage() {
  const [{ open, done, boardAt }, { meta }] = await Promise.all([getPicks(), getExchange()]);
  const stale = !boardAt || Date.now() - new Date(boardAt).getTime() > 3 * 3600000;
  const total = summary(done);
  const weeks = [...new Set(done.map((p) => weekOf(p.start)))].sort().reverse();
  const tiers = ["A", "B"];
  const kinds: ["spread" | "total", string][] = [["spread", "Spread"], ["total", "Total"]];
  const recent = [...done].sort((a, b) => (b.graded ?? "").localeCompare(a.graded ?? "")).slice(0, 40);
  const upcoming = [...open].sort((a, b) => a.start.localeCompare(b.start));
  const sideText = (p: Pick) => (p.kind === "spread" ? `${p.side === "home" ? p.home : p.away} ${p.side === "home" ? (p.line > 0 ? `-${p.line}` : `+${Math.abs(p.line)}`) : p.line > 0 ? `+${p.line}` : `-${Math.abs(p.line)}`}` : `${p.side === "over" ? "Over" : "Under"} ${p.line}`);
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="picks" round={meta} />
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
            ["Open picks", String(open.length)],
            ["Graded", String(done.length)],
            ["Flat record", done.length ? `${total.w}-${total.l}${total.push ? `-${total.push}` : ""}` : "–"],
            ["Flat ROI", done.length ? `${sg(total.roi * 100, 1)}%` : "–"],
            ["Avg CLV (points)", done.length ? sg(total.clv) : "–"],
          ].map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>)}
        </div>

        <h3 className="mb-2 text-sm font-semibold text-foreground">Open picks</h3>
        {upcoming.length === 0 ? (
          <p className="mb-6 rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">No open picks.</p>
        ) : (
          <div className="mb-6 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Starts</th><th className="px-3 py-2">Pick</th><th className="px-3 py-2">Tier</th><th className="px-3 py-2 text-right">Predicted move</th><th className="px-3 py-2 text-right">Scaled units</th><th className="px-3 py-2">Logged</th></tr></thead>
              <tbody className="font-mono">
                {upcoming.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-sans text-foreground">{p.teams}<span className="block text-[10px] text-muted">{NAME[p.source] ?? p.source}</span></td>
                    <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={p.start} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></td>
                    <td className="px-3 py-1.5 font-sans text-foreground">{sideText(p)}<span className="block text-[10px] text-muted">{p.kind === "spread" ? "spread" : "total"}{p.open != null ? `, opened ${p.open}` : ""}</span></td>
                    <td className="px-3 py-1.5 font-sans text-muted">{p.tier}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{sg(p.rem, 1)} pts</td>
                    <td className="px-3 py-1.5 text-right text-muted">{p.units_scaled.toFixed(2)}</td>
                    <td className="px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={p.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
            <h3 className="mb-2 text-sm font-semibold text-foreground">By market and tier</h3>
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
    </div>
  );
}
