import Link from "next/link";

import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getResults, type ExResult } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number) => `${n > 0.05 ? "+" : ""}${n.toFixed(0)}`;
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;
const tone = (n: number, eps = 0.5) => (n > eps ? "text-up" : n < -eps ? "text-down" : "text-muted");

/** The Monday of the week a US-Eastern day (YYYY-MM-DD) falls in. Weeks run Monday to Sunday. */
function monday(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

type Agg = { pnl: number; traded: number; clvS: number; clvN: number; games: number };
const empty = (): Agg => ({ pnl: 0, traded: 0, clvS: 0, clvN: 0, games: 0 });

function aggregate(rows: ExResult[], sport: string | null): Record<string, Agg> {
  const out: Record<string, Agg> = {};
  for (const r of rows) {
    if (sport && r.sport !== sport) continue;
    for (const [sid, v] of Object.entries(r.syn)) {
      const a = (out[sid] ??= empty());
      a.pnl += v.pnl; a.traded += v.traded; a.clvS += v.clv_sum; a.clvN += v.clv_n; a.games += 1;
    }
  }
  return out;
}

export default async function WeeklyPage({ searchParams }: { searchParams: Promise<{ week?: string; sport?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const [results, { syndicates, meta }] = await Promise.all([getResults(120), getExchange()]);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const thisWeek = monday(today);
  const weeks = [...new Set([thisWeek, ...results.map((r) => monday(r.day))])].sort().reverse();
  const week = weeks.includes(sp.week ?? "") ? sp.week! : thisWeek;
  const prev = addDays(week, -7);
  const inWeek = (w: string) => results.filter((r) => monday(r.day) === w);
  const cur = aggregate(inWeek(week), sport), old = aggregate(inWeek(prev), sport);
  const bySport = Object.fromEntries(SPORTS.map((s) => [s, aggregate(inWeek(week), s)]));
  const syn = Object.fromEntries(syndicates.map((s) => [s.id, s]));
  const rows = Object.entries(cur).sort((a, b) => b[1].pnl - a[1].pnl);
  const games = new Set(inWeek(week).filter((r) => !sport || r.sport === sport).map((r) => r.id)).size;
  const q = (o: { week?: string; sport?: string | null }) => {
    const p = new URLSearchParams();
    const w = o.week ?? week, s = o.sport === undefined ? sport : o.sport;
    if (w !== thisWeek) p.set("week", w);
    if (s) p.set("sport", s);
    return `/syndicates/weekly${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const clvOf = (a?: Agg) => (a && a.clvN ? a.clvS / a.clvN : null);
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="weekly" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Weekly scorecard</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          How each trading firm did over a Monday to Sunday week (US Eastern, by the day a game started), compared with the week before. Realized is profit on games that finished; CLV is how far the closing price beat the price paid, per trade.
          A week fills in as games finish, so the current week is partial.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Week</span>
            {weeks.slice(0, 8).map((w) => <Link key={w} href={q({ week: w })} className={chip(w === week)}>{fmt(w)}{w === thisWeek ? " (so far)" : ""}</Link>)}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Sport</span>
            <Link href={q({ sport: null })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
        </div>
        <p className="mb-3 text-[11px] text-muted">{fmt(week)} to {fmt(addDays(week, 6))} · {games} finished games{sport ? ` in ${SPORT[sport]}` : ""} · previous week {fmt(prev)} to {fmt(addDays(prev, 6))}</p>

        {rows.length === 0 ? (
          <p className="mb-8 rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No games finished in this week yet.</p>
        ) : (
          <div className="mb-8 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">#</th><th className="px-3 py-2">Firm</th><th className="px-3 py-2 text-right">Games</th><th className="px-3 py-2 text-right">Realized</th>
                  <th className="px-3 py-2 text-right" title="Realized profit divided by the units put up on those games">Return</th>
                  <th className="px-3 py-2 text-right">CLV</th><th className="px-3 py-2 text-right">Last week CLV</th><th className="px-3 py-2 text-right">Change</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map(([sid, a], i) => {
                  const c = clvOf(a), pc = clvOf(old[sid]);
                  const d = c != null && pc != null ? c - pc : null;
                  return (
                    <tr key={sid} className="border-t border-border">
                      <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                      <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: syn[sid]?.color }} /><Link href={`/syndicates/${sid}`} className="hover:text-accent">{syn[sid]?.name ?? sid}</Link></td>
                      <td className="px-3 py-1.5 text-right text-muted">{a.games}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(a.pnl)}`}>{u(a.pnl)}{old[sid] ? <span className="ml-2 text-[10px] text-muted">{u(old[sid].pnl)}</span> : null}</td>
                      <td className={`px-3 py-1.5 text-right ${a.traded ? tone(a.pnl / a.traded, 0.002) : "text-muted"}`}>{a.traded ? `${((a.pnl / a.traded) * 100).toFixed(1)}%` : "–"}</td>
                      <td className={`px-3 py-1.5 text-right ${c == null ? "text-muted" : tone(c, 0.002)}`}>{c == null ? "–" : c1(c)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pc == null ? "–" : c1(pc)}</td>
                      <td className={`px-3 py-1.5 text-right ${d == null ? "text-muted" : tone(d, 0.002)}`}>{d == null ? "–" : `${d >= 0 ? "▲" : "▼"} ${(Math.abs(d) * 100).toFixed(1)}¢`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="-mt-6 mb-8 text-[10px] text-muted">The small figure beside Realized is last week&rsquo;s.</p>

        <h3 className="mb-2 text-sm font-semibold text-foreground">By sport this week</h3>
        <p className="mb-2 text-[11px] text-muted">Each cell is realized profit, with CLV underneath. Blank where the firm had no finished trades in that sport.</p>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Firm</th>{SPORTS.map((s) => <th key={s} className="px-3 py-2 text-right">{SPORT[s]}</th>)}</tr></thead>
            <tbody className="font-mono">
              {Object.keys(Object.fromEntries(SPORTS.flatMap((s) => Object.keys(bySport[s]).map((k) => [k, 1])))).sort((a, b) => (syn[a]?.name ?? a).localeCompare(syn[b]?.name ?? b)).map((sid) => (
                <tr key={sid} className="border-t border-border">
                  <td className="px-3 py-1.5 font-sans text-foreground"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: syn[sid]?.color }} />{syn[sid]?.name ?? sid}</td>
                  {SPORTS.map((s) => {
                    const a = bySport[s][sid];
                    const c = clvOf(a);
                    return (
                      <td key={s} className="px-3 py-1.5 text-right">
                        {a ? <><span className={tone(a.pnl)}>{u(a.pnl)}</span><span className={`block text-[10px] ${c == null ? "text-muted" : tone(c, 0.002)}`}>{c == null ? "" : c1(c)}</span></> : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
