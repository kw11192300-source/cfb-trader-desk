import BreakdownTable from "./BreakdownTable";
import PnlChart from "./PnlChart";
import { byWeek as summarizeByWeek, fmtPct, summarizeBets } from "@/lib/betBreakdown";
import type { Game } from "@/lib/types";
import type { GradedBet } from "@/lib/data";

/** Break-even win rate implied by American odds - the classic "52.4%"
 * figure is ONLY correct at exactly -110. Real bets here run from -108 to
 * -135 and beyond, so a flat 52.4% reference is actively misleading next
 * to real ROI - this computes the actual number per price taken. */
function impliedProb(odds: number): number {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

/** Which team a spread/moneyline bet is actually exposed to, and that
 * team's conference - null for total bets (over/under isn't exposure to
 * either team specifically, just to the game). */
function betExposure(bet: GradedBet["bet"], game: Game | null): { team: string | null; conference: string | null } {
  if (!game || bet.market === "total") return { team: null, conference: null };
  if (bet.side === game.home_team) return { team: game.home_team, conference: game.home_conference };
  if (bet.side === game.away_team) return { team: game.away_team, conference: game.away_conference };
  return { team: bet.side, conference: null };
}

function ExposureList({ title, rows }: { title: string; rows: { label: string; units: number }[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No pending exposure right now.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            const max = Math.max(...rows.map((x) => x.units));
            return (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-xs text-foreground">{r.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${max > 0 ? (r.units / max) * 100 : 0}%` }} />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-xs text-foreground">{r.units.toFixed(2)}u</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RiskDashboard({ bets }: { bets: GradedBet[] }) {
  const pending = bets.filter((b) => b.status === "pending");
  const graded = bets.filter((b) => b.status !== "pending");

  const exposureByConference = new Map<string, number>();
  const exposureByTeam = new Map<string, number>();
  for (const { bet, game } of pending) {
    const { team, conference } = betExposure(bet, game);
    if (conference) exposureByConference.set(conference, (exposureByConference.get(conference) ?? 0) + bet.stake);
    if (team) exposureByTeam.set(team, (exposureByTeam.get(team) ?? 0) + bet.stake);
  }
  const confRows = [...exposureByConference.entries()]
    .map(([label, units]) => ({ label, units }))
    .sort((a, b) => b.units - a.units);
  const teamRows = [...exposureByTeam.entries()]
    .map(([label, units]) => ({ label, units }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 10);

  const bySource = summarizeBets(graded, (g) => g.bet.edge_source).sort((a, b) => b.profit - a.profit);
  const byWeekRows = summarizeByWeek(graded);

  const totalPending = pending.reduce((s, b) => s + b.bet.stake, 0);
  const overallRoi = bySource.reduce((s, r) => s + r.staked, 0) > 0 ? (bySource.reduce((s, r) => s + r.profit, 0) / bySource.reduce((s, r) => s + r.staked, 0)) * 100 : null;
  const gradedStaked = graded.reduce((s, g) => s + g.bet.stake, 0);
  const weightedBreakEven = gradedStaked > 0 ? graded.reduce((s, g) => s + g.bet.stake * impliedProb(g.bet.odds), 0) / gradedStaked : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Pending exposure</div>
          <div className="font-mono text-lg text-foreground">{totalPending.toFixed(2)}u</div>
          <div className="text-[10px] text-muted">{pending.length} open bet{pending.length === 1 ? "" : "s"}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Graded bets</div>
          <div className="font-mono text-lg text-foreground">{graded.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Overall ROI</div>
          <div className={`font-mono text-lg ${(overallRoi ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtPct(overallRoi)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted" title="Stake-weighted, from the actual odds taken on graded bets - not a flat -110 assumption">
            Break-even (your odds)
          </div>
          <div className="font-mono text-lg text-muted">{weightedBreakEven !== null ? `${(weightedBreakEven * 100).toFixed(1)}%` : "—"}</div>
        </div>
      </div>

      <PnlChart bets={bets} />

      <div className="grid gap-5 md:grid-cols-2">
        <ExposureList title="Current exposure by conference" rows={confRows} />
        <ExposureList title="Current exposure by team (top 10)" rows={teamRows} />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <BreakdownTable title="By source" rows={bySource} labelHeader="Source" />
        <BreakdownTable title="By week" rows={byWeekRows} />
      </div>
    </div>
  );
}
