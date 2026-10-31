"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ramp, tierMult } from "@/lib/limits";
import type { GameRow } from "@/lib/syndicates";

const SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };

const subscribe = () => () => {};
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

const dayKey = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the viewer's own timezone
const keyToDate = (k: string) => new Date(`${k}T12:00:00`);
const p100 = (p: number | null | undefined) => (p == null ? "–" : `${Math.round(p * 100)}¢`);
const n0 = (v: number) => Math.round(v).toLocaleString();

function logoUrl(sport: string, t: { id: string; abbr: string }) {
  return sport === "cfb" || sport === "cbb" ? `https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${t.id}.png` : `https://a.espncdn.com/i/teamlogos/${sport}/500-dark/${t.abbr.toLowerCase()}.png`;
}

function Logo({ sport, team }: { sport: string; team: { id: string; abbr: string } }) {
  const [bad, setBad] = useState(false);
  if (bad) return <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-raised text-[10px] font-semibold text-muted">{team.abbr.slice(0, 3)}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={(el) => { if (el && el.complete && el.naturalWidth === 0) setBad(true); }} src={logoUrl(sport, team)} alt={team.abbr} width={32} height={32} className="h-8 w-8 object-contain" onError={() => setBad(true)} />;
}

function Card({ g }: { g: GameRow }) {
  const idx = (kind: string) => g.lines?.findIndex((l) => l[0] === kind) ?? -1;
  const price = (kind: string) => {
    const i = idx(kind);
    return i < 0 ? { line: null as number | null, dk: null as number | null, x: null as number | null } : { line: g.lines![i][1], dk: g.dk?.[i] ?? null, x: g.x?.[i] ?? null };
  };
  const ml = price("ml"), sp = price("spread"), tt = price("total");
  const start = new Date(g.start_utc);
  const hrs = Math.max(0, (start.getTime() - Date.now()) / 3600000);
  const live = g.state === "in";
  const status = g.completed ? "Final" : live ? "Live" : start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const score = g.completed || live;
  const row = (label: string, line: string, p: { dk: number | null; x: number | null }) => (
    <div className="grid grid-cols-[1fr_58px_58px] items-center gap-2 border-t border-border py-1 text-[11px]">
      <span className="truncate text-muted">{label} <span className="font-mono text-foreground">{line}</span></span>
      <span className={`text-right font-mono ${p.x == null ? "text-muted" : "text-foreground"}`}>{p100(p.x)}</span>
      <span className="text-right font-mono text-muted">{p100(p.dk)}</span>
    </div>
  );
  return (
    <Link href={`/syndicates/games/${encodeURIComponent(g.id)}`} className="block rounded-lg border border-border bg-surface p-3 transition hover:border-accent">
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="text-muted">{SPORT[g.sport]}</span>
        <span className={live ? "font-medium text-down" : g.completed ? "text-muted" : "text-foreground"}>{status}</span>
      </div>
      {([["away", g.away, g.away_score], ["home", g.home, g.home_score]] as const).map(([side, t, sc]) => (
        <div key={side} className="mb-1 flex items-center gap-2">
          <Logo sport={g.sport} team={t} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{t.name}</p>
          </div>
          {score && <span className="font-mono text-base font-semibold text-foreground">{sc ?? "–"}</span>}
        </div>
      ))}
      <div className="mt-2">
        <div className="grid grid-cols-[1fr_58px_58px] gap-2 pb-1 text-[10px] uppercase tracking-wide text-muted">
          <span>{g.lines ? `${g.home.abbr} side` : "No market yet"}</span><span className="text-right">Exchange</span><span className="text-right">DK</span>
        </div>
        {g.lines ? (
          <>
            {row("ML", `${g.home.abbr}`, ml)}
            {row("Spread", sp.line == null ? "" : `${g.home.abbr} ${sp.line > 0 ? "+" : ""}${sp.line}`, sp)}
            {row("Total", tt.line == null ? "" : `O/U ${tt.line}`, tt)}
          </>
        ) : (
          <p className="border-t border-border pt-2 text-[11px] text-muted">Prices appear once DraftKings lists the game or the syndicates open a line.</p>
        )}
      </div>
      {!g.completed && !live && start.getTime() > Date.now() && (
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted" title="Most one trader can have at risk on this game right now, and at kickoff. Limits rise as kickoff nears; college basketball also scales with the two teams' conferences.">
          <span>Limit now <span className="font-mono text-foreground">{Math.round(100 * ramp(hrs, g.sport) * (g.sport === "cbb" ? tierMult(g.tier, hrs) : 1))}</span> per trader{g.sport === "cbb" && g.tier ? <span className="ml-1.5 rounded bg-surface-raised px-1.5 py-0.5 text-[10px]" title="Conference tiers of the two teams: A power, B top mid-major, C other">{g.tier}</span> : null}</span>
          <span>at tip-off <span className="font-mono text-foreground">{Math.round(100 * ramp(0.5, g.sport) * (g.sport === "cbb" ? tierMult(g.tier, 0.5) : 1))}</span></span>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted">
        <span>{g.contracts > 0 ? <><span className="font-mono text-foreground">{n0(g.contracts)}</span> contracts · {n0(g.trades)} trades</> : "No trades yet"}</span>
        <span className="text-accent">Open →</span>
      </div>
    </Link>
  );
}

/** Games by day, in the viewer's own timezone: a strip of days to click across, a sport filter, and a card per game with volume and both prices. */
export default function GamesBrowser({ games }: { games: GameRow[] }) {
  const mounted = useMounted();
  const [pick, setPick] = useState<string | null>(null);
  const [sport, setSport] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  const { days, byDay, today } = useMemo(() => {
    const by: Record<string, GameRow[]> = {};
    if (!mounted) return { days: [] as string[], byDay: by, today: "" };
    for (const g of games) (by[dayKey(new Date(g.start_utc))] ??= []).push(g);
    const keys = Object.keys(by).sort();
    const t = dayKey(new Date());
    const all: string[] = [];
    if (keys.length) {
      const lo = keys[0] < t ? keys[0] : t, hi = keys[keys.length - 1] > t ? keys[keys.length - 1] : t;
      for (let d = keyToDate(lo); dayKey(d) <= hi; d = new Date(d.getTime() + 86400000)) all.push(dayKey(d));
    }
    return { days: all, byDay: by, today: t };
  }, [games, mounted]);

  if (!mounted) return <p className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-sm text-muted">Loading games…</p>;
  const sel = pick && days.includes(pick) ? pick : days.includes(today) ? today : days.find((d) => (byDay[d]?.length ?? 0) > 0) ?? days[0];
  const dayGames = (byDay[sel] ?? []).slice().sort((a, b) => a.start_utc.localeCompare(b.start_utc) || a.id.localeCompare(b.id));
  const shown = dayGames.filter((g) => !sport || g.sport === sport);
  const count = (s: string) => dayGames.filter((g) => g.sport === s).length;
  const chip = (on: boolean) => `shrink-0 rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const vol = shown.reduce((a, g) => a + g.contracts, 0);

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        <button type="button" aria-label="Earlier days" onClick={() => strip.current?.scrollBy({ left: -320, behavior: "smooth" })} className="rounded border border-border px-2 py-2 text-muted hover:text-foreground">‹</button>
        <div ref={strip} className="flex flex-1 gap-1 overflow-x-auto scroll-smooth py-0.5">
          {days.map((d) => {
            const n = byDay[d]?.length ?? 0;
            const dt = keyToDate(d);
            return (
              <button
                key={d}
                type="button"
                ref={d === sel ? (el) => el?.scrollIntoView({ block: "nearest", inline: "center" }) : undefined}
                onClick={() => setPick(d)}
                className={`flex w-[68px] shrink-0 flex-col items-center rounded-lg border px-1 py-1.5 text-center ${d === sel ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}
              >
                <span className="text-[10px] uppercase">{d === today ? "Today" : dt.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="text-sm font-semibold">{dt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="text-[10px]">{n} game{n === 1 ? "" : "s"}</span>
              </button>
            );
          })}
        </div>
        <button type="button" aria-label="Later days" onClick={() => strip.current?.scrollBy({ left: 320, behavior: "smooth" })} className="rounded border border-border px-2 py-2 text-muted hover:text-foreground">›</button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => setSport(null)} className={chip(!sport)}>All sports ({dayGames.length})</button>
          {SPORTS.filter((s) => count(s) > 0).map((s) => <button key={s} type="button" onClick={() => setSport(sport === s ? null : s)} className={chip(sport === s)}>{SPORT[s]} ({count(s)})</button>)}
        </div>
        <span className="text-muted">{keyToDate(sel).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · {shown.length} games · {n0(vol)} contracts traded</span>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-sm text-muted">No games {sport ? `in ${SPORT[sport]} ` : ""}on this day{dayGames.length ? "" : " in the exchange's window"}.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((g) => <Card key={g.id} g={g} />)}
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted">Prices are for the home team (moneyline and spread) and the over, in cents, as the chance of that side. Exchange is the exchange&rsquo;s own price; DK is DraftKings with the vig removed. Days follow your own clock.</p>
    </div>
  );
}
