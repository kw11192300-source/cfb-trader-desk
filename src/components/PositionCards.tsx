import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { type Band, type GameCard, gameCards } from "@/lib/positions";
import { dkPosted, type ExGame, fairOf, type Lot, pct } from "@/lib/syndicates";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const u = (n: number, d = 1) => `${n > 0.05 ? "+" : ""}${n.toFixed(d)}`;
const tone = (n: number) => (n > 0.05 ? "text-up" : n < -0.05 ? "text-down" : "text-muted");

function Outcomes({ title, bands, max }: { title: string; bands: Band[]; max: number }) {
  if (!bands.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">{title}</p>
      <div className="space-y-px">
        {bands.map((b, i) => {
          const w = Math.min(50, (Math.abs(b.pnl) / max) * 50);
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1.5fr)_36px_minmax(0,1fr)_52px] items-center gap-2 py-[3px] text-[11px]">
              <span className="truncate text-foreground" title={b.label}>{b.label}</span>
              <span className="text-right font-mono text-[10px] text-muted" title="Chance of this result, from DraftKings' price">{b.chance == null ? "" : `${(b.chance * 100).toFixed(0)}%`}</span>
              <div className="relative h-3">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                {b.pnl >= 0.05 && <div className="absolute inset-y-[2px] left-1/2 rounded-r bg-up/70" style={{ width: `${w}%` }} />}
                {b.pnl <= -0.05 && <div className="absolute inset-y-[2px] right-1/2 rounded-l bg-down/70" style={{ width: `${w}%` }} />}
              </div>
              <span className={`text-right font-mono ${tone(b.pnl)}`}>{u(b.pnl)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ c, limit, holder }: { c: GameCard; limit?: number; holder?: (id: string) => string }) {
  const { g } = c;
  const hrs = (new Date(g.start_utc).getTime() - Date.now()) / 3600000;
  const max = Math.max(1, ...c.margin.map((b) => Math.abs(b.pnl)), ...c.total.map((b) => Math.abs(b.pnl)));
  const mainLines = [g.ref?.spread != null ? `${g.home.abbr} ${g.ref.spread > 0 ? "+" : ""}${g.ref.spread}` : null, g.ref?.total != null ? `total ${g.ref.total}` : null].filter(Boolean).join(" · ");
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-semibold text-foreground">
          <span className="mr-2 text-[10px] font-normal text-muted">{SPORT[g.sport]}</span>
          <Link href={`/syndicates/games/${encodeURIComponent(c.gid)}`} className="hover:text-accent">{g.away.abbr} @ {g.home.abbr}</Link>
        </p>
        <p className="text-[11px] text-muted">
          <LocalDateTime iso={g.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} />
          {hrs > 0 && ` · in ${hrs >= 24 ? `${Math.floor(hrs / 24)}d ${Math.round(hrs % 24)}h` : `${hrs.toFixed(1)}h`}`}
          {mainLines && ` · ${dkPosted(g) ? "DK" : "line"} ${mainLines}`}
        </p>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-2 text-[11px]">
        {([["Contracts", String(Math.round(c.contracts)), "text-foreground"], ["Units put up", c.units.toFixed(0), "text-foreground"], ["Worst case", u(c.worst, 0), "text-down"], ["Best case", u(c.best, 0), "text-up"], ["Open P&L", u(c.mtm), tone(c.mtm)]] as [string, string, string][]).map(([k, v, t]) => (
          <div key={k}><p className="text-[10px] text-muted">{k}</p><p className={`font-mono text-sm ${t}`}>{v}</p></div>
        ))}
      </div>
      {limit != null && (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted" title="Worst case against the limit on this game right now">
          <div className="h-1 flex-1 rounded bg-surface-raised"><div className={`h-1 rounded ${-c.worst > limit * 0.9 ? "bg-down" : "bg-accent"}`} style={{ width: `${Math.min(100, (-c.worst / Math.max(1, limit)) * 100)}%` }} /></div>
          <span>{Math.round(-c.worst)} of {Math.round(limit)} limit</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {c.legs.map((l) => (
          <span key={`${l.kind}${l.line}`} className="rounded border border-border bg-background px-2 py-0.5 text-[11px]" title={holder ? Object.entries(l.holders).map(([h, q]) => `${holder(h)} ${q > 0 ? "+" : ""}${q.toFixed(0)}`).join(" · ") : undefined}>
            <span className="font-medium text-foreground">{l.text}</span>
            <span className="ml-1.5 font-mono text-muted">
              {Math.abs(l.net).toFixed(0)}{l.long > 0.05 && l.short > 0.05 ? ` (${l.long.toFixed(0)} long / ${l.short.toFixed(0)} short)` : ""} @ {pct(l.paid)}
            </span>
          </span>
        ))}
      </div>
      <Outcomes title="If it ends like this: result of the game" bands={c.margin} max={max} />
      <Outcomes title="If it ends like this: combined score" bands={c.total} max={max} />
    </div>
  );
}

/** One card per game with an open position: what is held, in plain words, and what every possible result would do to it. */
export function PositionCards({ lots, games, limitOf, holder, title = "Open positions by game" }: { lots: Lot[]; games: Record<string, ExGame>; limitOf?: (g: ExGame) => number; holder?: (id: string) => string; title?: string }) {
  const cards = gameCards(lots, games, fairOf);
  return (
    <section className="mb-8">
      <h3 className="mb-1 text-sm font-semibold text-foreground">{title}</h3>
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
        Soonest kickoff first. Each tag is a side held: a number of contracts at the average price paid for that side (backing &ldquo;AKR +7.5&rdquo; at 48¢ means 48¢ risked to win 52¢; against a long and a short on the same line, only the
        net is shown). Under it, every possible final result: the bar is what the position makes (green) or loses (red) in that case, the small percentage is how likely that result is by DraftKings&rsquo; price. The result of the
        game (side and spread bets) and the combined score (total bets) are separate bets, so a game&rsquo;s best or worst case adds one row from each.
      </p>
      {cards.length === 0 ? (
        <p className="text-xs text-muted">No open positions.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {cards.map((c) => <Card key={c.gid} c={c} limit={limitOf?.(c.g)} holder={holder} />)}
        </div>
      )}
    </section>
  );
}
