import Link from "next/link";
import type { GradedBet } from "@/lib/data";
import { etDay } from "@/lib/nhlTeamGames";

type Bucket = { net: number; staked: number; w: number; l: number; p: number; pendingUnits: number; pendingCount: number };
const empty = (): Bucket => ({ net: 0, staked: 0, w: 0, l: 0, p: 0, pendingUnits: 0, pendingCount: 0 });

const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
const roi = (b: Bucket) => (b.staked > 0 ? `${b.net >= 0 ? "+" : ""}${((b.net / b.staked) * 100).toFixed(0)}%` : "—");
const tone = (n: number) => (n > 0 ? "text-up" : n < 0 ? "text-down" : "text-foreground");

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function Cell({ title, b, showPending = true }: { title: string; b: Bucket; showPending?: boolean }) {
  const settled = b.w + b.l + b.p;
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted">{title}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        {settled > 0 || b.staked > 0 ? (
          <>
            <span className={`font-mono text-base font-semibold ${tone(b.net)}`}>{u(b.net)}</span>
            <span className="font-mono text-xs text-muted">ROI {roi(b)}</span>
            <span className="font-mono text-xs text-muted">
              {b.w}-{b.l}
              {b.p > 0 ? `-${b.p}` : ""}
            </span>
          </>
        ) : (
          <span className="font-mono text-base text-muted">—</span>
        )}
      </div>
      {showPending && (
        <div className="text-[11px] text-muted">
          {b.pendingCount > 0 ? (
            <>
              <span className="font-mono text-foreground">{b.pendingUnits.toFixed(2)}u</span> pending ({b.pendingCount} bet{b.pendingCount === 1 ? "" : "s"})
            </>
          ) : (
            "nothing pending"
          )}
        </div>
      )}
    </div>
  );
}

/** Your NHL bets at a glance by schedule day (Eastern): yesterday's result, today's settled result and what is still live, and
 * what is riding on tomorrow and later. Units are stakes as logged; ROI is profit over the settled stake. */
export default function NhlBetStrip({ bets, today }: { bets: GradedBet[]; today: string }) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  const yest = empty();
  const now = empty();
  const later = empty();
  for (const g of bets) {
    if (g.bet.sport !== "nhl" || !g.game) continue;
    const day = etDay(g.game.start_date);
    const target = day === yesterday ? yest : day === today ? now : day > today ? later : null;
    if (!target) continue;
    if (g.status === "pending" || g.profit === null) {
      target.pendingUnits += g.bet.stake;
      target.pendingCount++;
      continue;
    }
    target.net += g.profit;
    target.staked += g.bet.stake;
    if (g.status === "win") target.w++;
    else if (g.status === "loss") target.l++;
    else target.p++;
  }

  const hasAny = [yest, now, later].some((b) => b.staked > 0 || b.pendingCount > 0);
  if (!hasAny) return null;

  return (
    <section className="mb-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Your bets</h2>
        <Link href="/nhl/bets" className="text-[11px] text-muted hover:text-foreground">
          all bets ›
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Cell title={`Yesterday · ${dayLabel(yesterday)}`} b={yest} />
        <Cell title={`Today · ${dayLabel(today)}`} b={now} />
        <Cell title="Tomorrow & later" b={later} />
      </div>
    </section>
  );
}
