import Link from "next/link";

import AutoRefresh from "@/components/AutoRefresh";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { supabase } from "@/lib/supabase";
import { type ExGame, getExchange, getExchangeBoard } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

// Line movement: a live feed of DraftKings line moves (spread, total and moneyline each on its own row), how far each is from its open and its peak, when it last moved, and whether the exchange
// had already been pricing that way or moved first. The engine (python/exchange/linemoves.py) writes the events every round.

const SPORTS = ["cbb", "nba", "nhl", "cfb", "nfl"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const STARTS: [number, string][] = [[24, "24 hours"], [48, "2 days"], [72, "3 days"], [168, "7 days"]];
const WINDOWS: [number, string][] = [[10, "Last round"], [30, "30 min"], [60, "1 hour"], [240, "4 hours"], [1440, "24 hours"]];
const MKTS: [string, string][] = [["all", "All"], ["spread", "Spread"], ["total", "Total"], ["ml", "Moneyline"]];
const VIEWS: [string, string][] = [["moves", "Live moves"], ["exchange", "Exchange moved first"], ["open", "From open"]];

type Ev = {
  ts: string; gid: string; sport: string; teams: string; start: string; mkt: "spread" | "total" | "ml"; src: "dk" | "exch"; frm: number; to: number; d: number;
  o?: number; hi?: number; lo?: number; retrace?: number; gp?: number | null; led?: boolean; span?: number | null; line?: number; dk?: number; gap?: number; ok?: boolean; bounced?: boolean;
};
type Mv = { o: number; hi: number; lo: number; c?: number; ts?: string; d?: number };
type Params = { sport?: string; h?: string; w?: string; mkt?: string; view?: string; sort?: string };

const imp = (o: number) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const devig = (h: number | null | undefined, a: number | null | undefined) => (h == null || a == null ? null : imp(h) / (imp(h) + imp(a)));

/** The size at which a move on this market counts as steam: a point on a spread or total (half a goal on an NHL total), 3 cents on the moneyline. */
const thr = (mkt: string, sport: string) => (mkt === "ml" ? 0.03 : mkt === "total" && sport === "nhl" ? 0.5 : 1);
const norm = (mkt: string, sport: string, v: number) => Math.abs(v) / thr(mkt, sport);

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = s / 3600;
  return h < 24 ? `${h < 10 ? h.toFixed(1) : Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};
const dur = (min: number) => (min < 90 ? `${Math.round(min)} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`);

const sg = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
const lineTxt = (n: number) => { const v = Number(n.toFixed(1)); return v > 0 ? `+${v}` : `${v}`; };
const val = (mkt: string, v: number, home: string) => (mkt === "ml" ? `${home} ${(v * 100).toFixed(0)}%` : mkt === "spread" ? `${home} ${lineTxt(v)}` : `${Number(v.toFixed(1))}`);
const delta = (mkt: string, d: number) => (mkt === "ml" ? `${sg(d * 100)}¢` : sg(d));
const side = (mkt: string, d: number, home: string, away: string) => (mkt === "spread" ? (d < 0 ? home : away) : mkt === "total" ? (d > 0 ? "over" : "under") : d > 0 ? home : away);
const MK: Record<string, string> = { spread: "Spread", total: "Total", ml: "Moneyline" };

export default async function MovementPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const hours = STARTS.find(([h]) => String(h) === sp.h)?.[0] ?? 48;
  const win = WINDOWS.find(([m]) => String(m) === sp.w)?.[0] ?? 60;
  const mkt = MKTS.find(([k]) => k === sp.mkt)?.[0] ?? "all";
  const view = VIEWS.find(([k]) => k === sp.view)?.[0] ?? "moves";
  const bySize = sp.sort !== "recent";

  const [board, { meta }, { data: mv }] = await Promise.all([
    getExchangeBoard(hours),
    getExchange(),
    supabase.from("ex_meta").select("value").eq("key", "moves").maybeSingle(),
  ]);
  const events = ((mv?.value as { rows?: Ev[] } | undefined)?.rows ?? []);
  const nowMs = Date.now();
  const games: Record<string, ExGame> = Object.fromEntries(
    board.filter((g) => (g.ref?.src ?? "dk") === "dk" && new Date(g.start_utc).getTime() > nowMs && (!sport || g.sport === sport)).map((g) => [g.id, g]),
  );
  const inWin = events.filter((e) => games[e.gid] && nowMs - new Date(e.ts).getTime() <= win * 60000 && (mkt === "all" || e.mkt === mkt));

  const q = (o: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { sport: sport ?? undefined, h: hours === 48 ? undefined : String(hours), w: win === 60 ? undefined : String(win), mkt: mkt === "all" ? undefined : mkt, view: view === "moves" ? undefined : view, sort: bySize ? undefined : "recent", ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/movement${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const gameCell = (g: ExGame) => (
    <td className="px-3 py-1.5 font-sans text-foreground">
      <span className="mr-1.5 text-[10px] text-muted">{SPORT[g.sport]}</span>
      <Link href={`/syndicates/games/${encodeURIComponent(g.id)}`} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link>
      <div className="text-[10px] text-muted">starts in {dur((new Date(g.start_utc).getTime() - nowMs) / 60000)}</div>
    </td>
  );

  // ---- live moves: one row per game and market, everything DraftKings did to it inside the window
  type Agg = { g: ExGame; mkt: Ev["mkt"]; first: Ev; last: Ev; n: number; net: number; led: boolean; gp: number | null; caught: number | null; best: Ev };
  const aggs: Agg[] = [];
  const grouped: Record<string, Ev[]> = {};
  const bouncedN = inWin.filter((x) => x.src === "dk" && x.bounced).length;
  for (const e of inWin.filter((x) => x.src === "dk" && !x.bounced)) (grouped[`${e.gid}|${e.mkt}`] ??= []).push(e);
  for (const evs of Object.values(grouped)) {
    evs.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = evs[0], last = evs[evs.length - 1];
    const ledEv = evs.find((e) => e.led);
    aggs.push({
      g: games[last.gid], mkt: last.mkt, first, last, n: evs.length, net: last.to - first.frm, led: !!ledEv, gp: ledEv?.gp ?? null,
      caught: evs.some((e) => (e.span ?? 0) >= 30) ? Math.max(...evs.map((e) => e.span ?? 0)) : null, best: evs.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a)),
    });
  }
  aggs.sort((a, b) => (bySize ? norm(b.mkt, b.g.sport, b.net) - norm(a.mkt, a.g.sport, a.net) : b.last.ts.localeCompare(a.last.ts)));

  // ---- exchange moved first
  type XAgg = { g: ExGame; mkt: Ev["mkt"]; last: Ev; first: Ev; n: number; followed: Ev | null };
  const xs: XAgg[] = [];
  const xg: Record<string, Ev[]> = {};
  for (const e of inWin.filter((x) => x.src === "exch")) (xg[`${e.gid}|${e.mkt}`] ??= []).push(e);
  for (const evs of Object.values(xg)) {
    evs.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = evs[0], last = evs[evs.length - 1];
    const followed = events.find((e) => e.src === "dk" && e.gid === last.gid && e.mkt === last.mkt && e.ts > first.ts) ?? null;
    xs.push({ g: games[last.gid], mkt: last.mkt, first, last, n: evs.length, followed });
  }
  xs.sort((a, b) => (bySize ? Math.abs(b.last.to - b.first.frm) - Math.abs(a.last.to - a.first.frm) : b.last.ts.localeCompare(a.last.ts)));

  // ---- from open: every DraftKings game's three markets on their own rows
  type Orow = { g: ExGame; mkt: Ev["mkt"]; o: number; now: number; hi: number | null; lo: number | null; ts: string | null; score: number };
  const orows: Orow[] = [];
  for (const g of Object.values(games)) {
    const ro = g.ref_open as unknown as { spread: number | null; total: number | null; ml_home: number | null; ml_away?: number | null } | null;
    const rn = g.ref as unknown as { spread: number | null; total: number | null; ml_home: number | null; ml_away: number | null } | null;
    const st = (g.views as unknown as { mv?: Record<string, Mv> } | null)?.mv ?? {};
    for (const m of ["spread", "total", "ml"] as const) {
      if (mkt !== "all" && mkt !== m) continue;
      if (m === "spread" && g.sport === "nhl") continue; // a hockey puck line is always 1.5 and changes sign when the favourite switches
      const now = st[m]?.c ?? (m === "ml" ? devig(rn?.ml_home, rn?.ml_away) : rn?.[m]);
      const o = st[m]?.o ?? (m === "ml" ? devig(ro?.ml_home, ro?.ml_away) : ro?.[m]);
      if (now == null || o == null) continue;
      orows.push({ g, mkt: m, o, now, hi: st[m]?.hi ?? null, lo: st[m]?.lo ?? null, ts: st[m]?.ts ?? null, score: norm(m, g.sport, now - o) });
    }
  }
  orows.sort((a, b) => (bySize ? b.score - a.score : (b.ts ?? "").localeCompare(a.ts ?? "")));

  const counts = { steam: aggs.filter((a) => norm(a.mkt, a.g.sport, a.net) >= 1).length, led: aggs.filter((a) => a.led).length, rev: aggs.filter((a) => (a.last.retrace ?? 0) >= thr(a.mkt, a.g.sport)).length };
  const lastEv = events[0]?.ts;

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="movement" round={meta} />
      <AutoRefresh seconds={60} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Line movement: what DraftKings just did, and whether the exchange saw it coming</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every spread, total and moneyline on a game DraftKings has priced is its own row. The exchange checks each one every round (about every 5 minutes) and logs a move with the time it happened. <strong>STEAM</strong> is a net move of a point or more on a spread or total
          (half a goal on an NHL total) or 3¢ on a moneyline inside the window. <strong>REVERSAL</strong> marks a move back toward the open from a peak, a point or more. <strong>EXCHANGE LED</strong> means the exchange was already pricing the way DraftKings then moved, a round earlier.
          <strong> Exchange moved first</strong> lists the exchange&rsquo;s price moving 2¢ or more in a round while DraftKings stood still. The page refreshes itself every minute.
        </p>

        <div className="mb-3 flex flex-wrap gap-1 text-[11px]">
          {VIEWS.map(([k, name]) => <Link key={k} href={q({ view: k === "moves" ? undefined : k })} className={chip(view === k)}>{name}</Link>)}
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Starts within</span>
            {STARTS.map(([h, name]) => <Link key={h} href={q({ h: h === 48 ? undefined : String(h) })} className={chip(hours === h)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Market</span>
            {MKTS.map(([k, name]) => <Link key={k} href={q({ mkt: k === "all" ? undefined : k })} className={chip(mkt === k)}>{name}</Link>)}
          </div>
          {view !== "open" && (
            <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Moved in the last</span>
              {WINDOWS.map(([m, name]) => <Link key={m} href={q({ w: m === 60 ? undefined : String(m) })} className={chip(win === m)}>{name}</Link>)}
            </div>
          )}
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Order</span>
            <Link href={q({ sort: undefined })} className={chip(bySize)}>Biggest</Link>
            <Link href={q({ sort: "recent" })} className={chip(!bySize)}>Most recent</Link>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Markets that moved", String(aggs.length)],
            ["Steam", String(counts.steam)],
            ["Reversals", String(counts.rev)],
            ["Exchange led / moved first", `${counts.led} / ${xs.length}`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-muted">Last move logged anywhere: {lastEv ? ago(lastEv) : "none yet"}. A move appears the round it is first seen (marked NEW); if the next round has it straight back it is hidden as a flicker{bouncedN > 0 ? ` (${bouncedN} in this window)` : ""}. A market only shows once the exchange has watched it move, so a line that has not moved since tracking began is not here.</p>

        {view === "moves" && (aggs.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No DraftKings line has moved in this window at this setting. Try a longer window.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1000px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">When</th><th className="px-3 py-2">Game</th><th className="px-3 py-2">Market</th>
                  <th className="px-3 py-2">Move in window</th><th className="px-3 py-2">From open</th><th className="px-3 py-2">Peak</th><th className="px-3 py-2">Exchange</th><th className="px-3 py-2">Flag</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {aggs.slice(0, 80).map((a) => {
                  const g = a.g, h = g.home.abbr, aw = g.away.abbr;
                  const big = norm(a.mkt, g.sport, a.net) >= 1;
                  const rev = (a.last.retrace ?? 0) >= thr(a.mkt, g.sport);
                  const o = a.last.o ?? a.first.o;
                  const extreme = a.last.hi != null && a.last.lo != null && o != null ? (Math.abs(a.last.hi - o) >= Math.abs(a.last.lo - o) ? a.last.hi : a.last.lo) : null;
                  return (
                    <tr key={`${g.id}${a.mkt}`} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 text-muted" title={new Date(a.last.ts).toLocaleString()}>{ago(a.last.ts)}{a.n > 1 && <div className="text-[10px]">{a.n} moves · first {ago(a.first.ts)}</div>}</td>
                      {gameCell(g)}
                      <td className="px-3 py-1.5 font-sans text-foreground">{MK[a.mkt]}</td>
                      <td className="px-3 py-1.5">
                        {val(a.mkt, a.first.frm, h)} → <span className="text-foreground">{val(a.mkt, a.last.to, h)}</span>
                        <span className={`ml-1 ${big ? "text-accent" : "text-muted"}`}>({delta(a.mkt, a.net)})</span>
                        <div className="font-sans text-[10px] text-muted">toward {side(a.mkt, a.net, h, aw)}</div>
                      </td>
                      <td className="px-3 py-1.5 text-muted">{o != null ? `${val(a.mkt, o, h)} → ${val(a.mkt, a.last.to, h)}` : "–"}{o != null && <span className="ml-1">({delta(a.mkt, a.last.to - o)})</span>}</td>
                      <td className="px-3 py-1.5 text-muted">{extreme != null ? val(a.mkt, extreme, h) : "–"}{rev && <div className="font-sans text-[10px] text-accent">back {a.mkt === "ml" ? `${((a.last.retrace ?? 0) * 100).toFixed(0)}¢` : (a.last.retrace ?? 0).toFixed(1)} from the peak</div>}</td>
                      <td className="px-3 py-1.5 text-muted">{a.gp != null && a.gp >= 0.015 ? `${(a.gp * 100).toFixed(1)}¢ ahead of DK` : a.best.gp != null ? `${(a.best.gp * 100).toFixed(1)}¢` : "–"}</td>
                      <td className="px-3 py-1.5 font-sans">
                        {big && <span className="mr-1 rounded bg-down/20 px-1.5 py-0.5 text-[10px] font-semibold text-down">STEAM</span>}
                        {rev && <span className="mr-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">REVERSAL</span>}
                        {a.led && <span className="mr-1 rounded bg-up/15 px-1.5 py-0.5 text-[10px] text-up">EXCHANGE LED</span>}
                        {a.last.ok === false && Date.now() - new Date(a.last.ts).getTime() < 12 * 60000 && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted" title="Seen this round, not yet checked against the next one">NEW</span>}
                        {a.caught != null && <div className="mt-0.5 text-[10px] text-muted">seen after a {dur(a.caught)} gap</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {view === "exchange" && (xs.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">The exchange has not moved 2¢ or more ahead of DraftKings on any market in this window.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Game</th><th className="px-3 py-2">Market</th><th className="px-3 py-2">Exchange price</th><th className="px-3 py-2">Gap to DraftKings</th><th className="px-3 py-2">Did DraftKings follow?</th></tr>
              </thead>
              <tbody className="font-mono">
                {xs.slice(0, 80).map((a) => {
                  const g = a.g, up = a.last.to - a.first.frm;
                  const fd = a.followed;
                  const same = fd ? (a.mkt === "spread" ? fd.d < 0 === up > 0 : fd.d > 0 === up > 0) : false;
                  return (
                    <tr key={`${g.id}${a.mkt}`} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 text-muted" title={new Date(a.last.ts).toLocaleString()}>{ago(a.last.ts)}{a.n > 1 && <div className="text-[10px]">{a.n} moves</div>}</td>
                      {gameCell(g)}
                      <td className="px-3 py-1.5 font-sans text-foreground">{MK[a.mkt]}{a.last.line != null && <span className="ml-1 text-muted">{a.mkt === "spread" ? lineTxt(a.last.line) : a.mkt === "total" ? a.last.line : ""}</span>}</td>
                      <td className="px-3 py-1.5">{(a.first.frm * 100).toFixed(1)}¢ → <span className="text-foreground">{(a.last.to * 100).toFixed(1)}¢</span><span className={`ml-1 ${Math.abs(up) >= 0.03 ? "text-accent" : "text-muted"}`}>({sg(up * 100)}¢)</span></td>
                      <td className="px-3 py-1.5 text-muted">{a.last.gap != null ? `${sg(a.last.gap * 100)}¢ (${a.mkt === "total" ? (a.last.gap > 0 ? "over" : "under") : a.mkt === "spread" ? (a.last.gap > 0 ? g.home.abbr : g.away.abbr) : a.last.gap > 0 ? g.home.abbr : g.away.abbr})` : "–"}</td>
                      <td className="px-3 py-1.5 font-sans">{fd ? <span className={same ? "text-up" : "text-down"}>{same ? "Yes" : "Moved the other way"}, {ago(fd.ts)}</span> : <span className="text-muted">Not yet</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {view === "open" && (orows.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No DraftKings lines at this setting.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Market</th><th className="px-3 py-2">Open → now</th><th className="px-3 py-2">Range since open</th><th className="px-3 py-2">Last moved</th><th className="px-3 py-2">Flag</th></tr>
              </thead>
              <tbody className="font-mono">
                {orows.slice(0, 80).map((r) => {
                  const d = r.now - r.o, big = norm(r.mkt, r.g.sport, d) >= 1;
                  const h = r.g.home.abbr;
                  return (
                    <tr key={`${r.g.id}${r.mkt}`} className="border-t border-border align-top">
                      {gameCell(r.g)}
                      <td className="px-3 py-1.5 font-sans text-foreground">{MK[r.mkt]}</td>
                      <td className="px-3 py-1.5">{val(r.mkt, r.o, h)} → <span className="text-foreground">{val(r.mkt, r.now, h)}</span><span className={`ml-1 ${big ? "text-accent" : "text-muted"}`}>({delta(r.mkt, d)})</span>{Math.abs(d) > 1e-9 && <div className="font-sans text-[10px] text-muted">toward {side(r.mkt, d, h, r.g.away.abbr)}</div>}</td>
                      <td className="px-3 py-1.5 text-muted">{r.lo != null && r.hi != null && r.hi - r.lo > 1e-9 ? `${val(r.mkt, r.lo, h)} to ${val(r.mkt, r.hi, h)}` : "–"}</td>
                      <td className="px-3 py-1.5 text-muted" title={r.ts ? new Date(r.ts).toLocaleString() : undefined}>{r.ts ? ago(r.ts) : "not seen moving"}</td>
                      <td className="px-3 py-1.5 font-sans">{big && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">MOVED</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </main>
    </div>
  );
}
