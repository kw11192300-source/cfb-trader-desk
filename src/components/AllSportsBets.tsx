"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { DeskBet, HistBet } from "@/lib/deskBets";

export type { DeskBet, HistBet };

export const SPORT_LABEL: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
export const SPORT_TONE: Record<string, string> = { cfb: "text-orange-300", nfl: "text-sky-300", nhl: "text-cyan-300", cbb: "text-amber-300", nba: "text-rose-300" };
export const SPORTS = ["cfb", "nfl", "nhl", "cbb", "nba"];
export const gameHref = (sport: string, id: number): string | null =>
  sport === "nba" ? `/nba/games/${id}` : sport === "nhl" ? `/nhl/games/${id}` : sport === "cbb" ? `/cbb/games/${id}` : sport === "cfb" ? `/games/${id}` : null;

const sp = (n: number) => (n > 0 ? `+${n}` : `${n}`);
export const units = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
export const tone = (n: number) => (n > 0 ? "text-up" : n < 0 ? "text-down" : "text-foreground");

function describe(b: DeskBet): string {
  if (b.market === "prop") return `${b.player ?? ""} ${b.side} ${b.line} ${b.propType ?? ""}`.trim();
  if (b.market === "moneyline") return `${b.side} ML`;
  if (b.market === "total") return `${b.side === "over" ? "Over" : "Under"} ${b.line}`;
  if (b.market === "parlay") return b.side;
  return `${b.side} ${sp(b.line)}`;
}
export const marketLabel = (m: string) => (m === "moneyline" ? "ML" : m === "prop" ? "Prop" : m === "parlay" ? "Parlay" : m === "total" ? "Total" : "Spread");
export const short = (team: string | null, sport: string) => {
  if (!team) return "?";
  if (sport === "nba" || sport === "nhl") return team.endsWith("Trail Blazers") ? "Trail Blazers" : team.split(" ").slice(-1)[0];
  return team;
};

// the viewer's own calendar day - the server cannot know it, so the list renders once the page is in the browser
const subscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
export const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
const shiftKey = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};
const dayLabel = (key: string, today: string) => (key === today ? "Today" : new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));

export function Row({ b }: { b: DeskBet }) {
  const color = b.status === "win" ? "text-up" : b.status === "loss" ? "text-down" : b.status === "push" ? "text-muted" : "text-accent";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1">
      <span className="min-w-0 text-foreground">
        <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{marketLabel(b.market)}</span>
        {describe(b)}
        {b.legs && b.legs.length > 0 && <span className="block pl-1 text-[11px] text-muted">{b.legs.join(" · ")}</span>}
      </span>
      <span className="flex items-baseline gap-3 font-mono text-[11px]">
        <span className="text-muted">
          {sp(b.odds)} · {b.stake}u{b.book ? ` · ${b.book}` : ""}
        </span>
        <span className={`w-24 text-right ${color}`}>{b.status === "pending" ? "PENDING" : `${b.status.toUpperCase()} ${b.profit !== null ? units(b.profit) : ""}`}</span>
      </span>
    </li>
  );
}

/** Every bet you have on one day across all sports, ordered by game time, with sport filters and a risked / pending / settled summary.
 * "Day" is the viewer's own calendar day. Parlays span games, so they sit at the bottom under the day they were placed. */
export default function AllSportsBets({ bets, history = [] }: { bets: DeskBet[]; history?: HistBet[] }) {
  const mounted = useMounted();
  const today = mounted ? new Date().toLocaleDateString("en-CA") : "";
  const [offset, setOffset] = useState(0);
  const [only, setOnly] = useState<string>("all");
  const day = today ? shiftKey(today, offset) : "";

  const view = useMemo(() => {
    if (!mounted) return null;
    const keep = (b: DeskBet) => only === "all" || b.sport === only;
    const games = new Map<number, { sport: string; start: string; away: string | null; home: string | null; completed: boolean; live: boolean; liveDetail: string | null; awayPts: number | null; homePts: number | null; bets: DeskBet[] }>();
    const parlays: DeskBet[] = [];
    for (const b of bets) {
      if (!keep(b)) continue;
      if (b.gameId !== null && b.start && dayKey(b.start) === day) {
        const g = games.get(b.gameId) ?? { sport: b.sport, start: b.start, away: b.away, home: b.home, completed: b.completed, live: b.live, liveDetail: b.liveDetail, awayPts: b.awayPts, homePts: b.homePts, bets: [] };
        g.bets.push(b);
        games.set(b.gameId, g);
      } else if (b.market === "parlay" && b.gameId === null && dayKey(b.placedAt) === day) parlays.push(b);
    }
    const list = [...games.entries()].sort((a, b) => new Date(a[1].start).getTime() - new Date(b[1].start).getTime());
    const all = [...list.flatMap(([, g]) => g.bets), ...parlays];
    return { list, parlays, all };
  }, [bets, day, mounted, only]);

  const hist = useMemo(() => {
    if (!mounted) return null;
    const byDay = new Map<string, { n: number; pending: number; risked: number; net: number; settled: number }>();
    for (const h of history) {
      if (only !== "all" && h.sport !== only) continue;
      const k = dayKey(h.t);
      const d = byDay.get(k) ?? { n: 0, pending: 0, risked: 0, net: 0, settled: 0 };
      d.n += 1;
      if (h.status === "pending") d.pending += 1;
      else {
        d.settled += 1;
        d.risked += h.stake;
        d.net += h.profit ?? 0;
      }
      byDay.set(k, d);
    }
    const asc = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let cum = 0;
    const rows = asc.map(([k, d]) => ({ day: k, ...d, cum: (cum += d.net) }));
    const total = rows.reduce((t, r) => ({ n: t.n + r.n, pending: t.pending + r.pending, risked: t.risked + r.risked, net: t.net + r.net, settled: t.settled + r.settled }), { n: 0, pending: 0, risked: 0, net: 0, settled: 0 });
    return { rows: rows.reverse(), total };
  }, [history, mounted, only]);

  if (!mounted || !view) return <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">Loading your bets…</div>;

  const { list, parlays, all } = view;
  const staked = all.reduce((s, b) => s + b.stake, 0);
  const settled = all.filter((b) => b.status !== "pending");
  const pending = all.filter((b) => b.status === "pending");
  const net = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const wins = settled.filter((b) => b.status === "win").length;
  const losses = settled.filter((b) => b.status === "loss").length;
  const bySport = SPORTS.map((s) => ({ s, n: all.filter((b) => b.sport === s).length, u: all.filter((b) => b.sport === s).reduce((t, b) => t + b.stake, 0) })).filter((x) => x.n > 0);
  const days = [-2, -1, 0, 1, 2, 3].map((n) => shiftKey(today, n));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {days.map((d, i) => (
            <button
              key={d}
              onClick={() => setOffset(i - 2)}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${d === day ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
            >
              {dayLabel(d, today)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-md border border-border p-0.5 text-xs">
          {["all", ...SPORTS].map((s) => (
            <button key={s} onClick={() => setOnly(s)} className={`rounded px-2 py-1 font-medium transition-colors ${only === s ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
              {s === "all" ? "All" : SPORT_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface px-5 py-4 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Bets</div>
          <div className="font-mono text-lg font-semibold text-foreground">{all.length}</div>
          <div className="text-[11px] text-muted">{bySport.map((x) => `${SPORT_LABEL[x.s]} ${x.n}`).join(" · ") || "none logged"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Risked</div>
          <div className="font-mono text-lg font-semibold text-foreground">{staked.toFixed(2)}u</div>
          <div className="text-[11px] text-muted">{bySport.map((x) => `${SPORT_LABEL[x.s]} ${x.u.toFixed(2)}u`).join(" · ") || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Pending</div>
          <div className="font-mono text-lg font-semibold text-accent">{pending.reduce((s, b) => s + b.stake, 0).toFixed(2)}u</div>
          <div className="text-[11px] text-muted">{pending.length} bet{pending.length === 1 ? "" : "s"} still live</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Settled</div>
          <div className={`font-mono text-lg font-semibold ${tone(net)}`}>{settled.length ? units(net) : "—"}</div>
          <div className="text-[11px] text-muted">
            {wins}-{losses}
            {settled.length - wins - losses > 0 ? `-${settled.length - wins - losses}` : ""}
          </div>
        </div>
      </div>

      {all.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">No bets logged for {dayLabel(day, today).toLowerCase()}{only === "all" ? "" : ` in ${SPORT_LABEL[only]}`}.</div>
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border bg-surface text-xs">
          {list.map(([id, g]) => {
            const href = gameHref(g.sport, id);
            const live = g.live && !g.completed;
            const title = `${short(g.away, g.sport)} @ ${short(g.home, g.sport)}`;
            return (
              <div key={id} className="px-4 py-2.5">
                <div className="mb-0.5 flex items-baseline justify-between gap-3">
                  <span className="flex items-baseline gap-2">
                    <span className={`text-[10px] font-semibold tracking-wide ${SPORT_TONE[g.sport] ?? "text-muted"}`}>{SPORT_LABEL[g.sport] ?? g.sport.toUpperCase()}</span>
                    {href ? (
                      <Link href={href} className="font-medium text-foreground hover:underline">
                        {title}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{title}</span>
                    )}
                  </span>
                  <span className={`text-[11px] ${live ? "font-medium text-down" : "text-muted"}`}>
                    {g.completed
                      ? `Final ${g.awayPts ?? "—"}-${g.homePts ?? "—"}`
                      : live
                        ? `LIVE${g.liveDetail ? ` · ${g.liveDetail}` : ""}`
                        : new Date(g.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
                <ul>
                  {g.bets.map((b) => (
                    <Row key={b.id} b={b} />
                  ))}
                </ul>
              </div>
            );
          })}
          {parlays.length > 0 && (
            <div className="px-4 py-2.5">
              <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">Parlays placed this day</div>
              <ul>
                {parlays.map((b) => (
                  <Row key={b.id} b={b} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {hist && hist.rows.length > 0 && (
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold text-foreground">Every day{only === "all" ? "" : ` · ${SPORT_LABEL[only]}`}</h2>
            <span className="font-mono text-[11px] text-muted">
              {hist.total.settled} settled · {hist.total.risked.toFixed(2)}u risked ·{" "}
              <span className={tone(hist.total.net)}>{units(hist.total.net)}</span> ·{" "}
              <span className={tone(hist.total.net)}>{hist.total.risked > 0 ? `${hist.total.net >= 0 ? "+" : ""}${((hist.total.net / hist.total.risked) * 100).toFixed(1)}% ROI` : "—"}</span>
            </span>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-1.5 text-left font-medium">Day</th>
                  <th className="px-2 py-1.5 text-right font-medium">Bets</th>
                  <th className="px-2 py-1.5 text-right font-medium" title="Stake on bets that have settled">Risked</th>
                  <th className="px-2 py-1.5 text-right font-medium" title="Net units won or lost on settled bets">Return</th>
                  <th className="px-2 py-1.5 text-right font-medium" title="Return divided by risked">ROI</th>
                  <th className="px-4 py-1.5 text-right font-medium" title="Running total of Return, oldest day to this one">Cumulative</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {hist.rows.map((r) => (
                  <tr key={r.day} className="border-t border-border/50">
                    <td className="px-4 py-1.5 font-sans text-foreground">
                      {dayLabel(r.day, today)}
                      {r.day.slice(0, 4) !== today.slice(0, 4) && <span className="ml-1.5 text-[10px] text-muted">{r.day.slice(0, 4)}</span>}
                      {r.pending > 0 && <span className="ml-2 text-[10px] text-accent">{r.pending} pending</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted">{r.n}</td>
                    <td className="px-2 py-1.5 text-right text-foreground">{r.risked > 0 ? `${r.risked.toFixed(2)}u` : "—"}</td>
                    <td className={`px-2 py-1.5 text-right ${r.settled ? tone(r.net) : "text-muted"}`}>{r.settled ? units(r.net) : "—"}</td>
                    <td className={`px-2 py-1.5 text-right ${r.settled ? tone(r.net) : "text-muted"}`}>{r.risked > 0 ? `${r.net >= 0 ? "+" : ""}${((r.net / r.risked) * 100).toFixed(1)}%` : "—"}</td>
                    <td className={`px-4 py-1.5 text-right ${tone(r.cum)}`}>{units(r.cum)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
