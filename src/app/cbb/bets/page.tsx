import BetsLedger from "@/components/BetsLedger";
import BreakdownTable from "@/components/BreakdownTable";
import CbbRefreshButtons from "@/components/CbbRefreshButtons";
import PnlChart from "@/components/PnlChart";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { byMarket } from "@/lib/betBreakdown";
import { getBets, getCbbSnapshotsMany } from "@/lib/data";
import { nbaBetClv } from "@/lib/nbaBetClv";
import type { Clv } from "@/lib/nhlBetClv";

export const dynamic = "force-dynamic";

export default async function CbbBetsPage() {
  const allBets = await getBets({ sport: "cbb", withLines: false });
  const bets = allBets.filter((b) => b.bet.sport === "cbb");
  const graded = bets.filter((b) => b.status !== "pending");

  // closing-line value: each bet against the last line we logged before tip-off
  const snaps = await getCbbSnapshotsMany([...new Set(bets.map((b) => b.bet.game_id).filter((id): id is number => id !== null))]);
  const clvByBet: Record<number, Clv | null> = {};
  for (const b of bets) clvByBet[b.bet.id] = b.bet.game_id === null ? null : nbaBetClv(b.bet, b.game, snaps.get(b.bet.game_id));
  const priceClv = bets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "%");
  const lineClv = bets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "pts");
  const avgClv = priceClv.length ? priceClv.reduce((s, c) => s + c.value, 0) / priceClv.length : null;
  const avgPts = lineClv.length ? lineClv.reduce((s, c) => s + c.value, 0) / lineClv.length : null;
  const beat = [...priceClv, ...lineClv].filter((c) => c.value > 0).length;
  const sampled = priceClv.length + lineClv.length;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bets" sport="cbb" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <CbbRefreshButtons updatedAt={null} scoresOnly />
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Every college basketball bet actually placed. Spread, moneyline and total grade off ESPN&apos;s final score. The edge the board is built around is
          closing-line value: over many bets, getting a better number than where the line closes is what predicts profit, and it settles far faster than wins and
          losses.
        </p>

        {sampled > 0 && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Avg. line value</div>
              <div className={`font-mono text-lg font-semibold ${avgPts === null ? "text-foreground" : avgPts >= 0 ? "text-up" : "text-down"}`}>{avgPts === null ? "—" : `${avgPts >= 0 ? "+" : ""}${avgPts.toFixed(2)} pts`}</div>
              <div className="text-[11px] text-muted">your number vs the close, spreads and totals ({lineClv.length} bets)</div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Avg. price value</div>
              <div className={`font-mono text-lg font-semibold ${avgClv === null ? "text-foreground" : avgClv >= 0 ? "text-up" : "text-down"}`}>{avgClv === null ? "—" : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}%`}</div>
              <div className="text-[11px] text-muted">same number, price vs the close ({priceClv.length} bets)</div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Beat the close</div>
              <div className="font-mono text-lg font-semibold text-foreground">
                {beat} of {sampled}
              </div>
              <div className="text-[11px] text-muted">better price or line than where it closed</div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-[11px] leading-relaxed text-muted">
              The close is the last line we logged before tip-off (ESPN / DraftKings, for now). Betting another book&apos;s price still works as a yardstick, but their vig differs.
            </div>
          </div>
        )}

        <div className="mb-5">
          <PnlChart bets={bets} />
        </div>
        <div className="mb-5 max-w-xl">
          <BreakdownTable title="By Market" rows={byMarket(graded)} labelHeader="Market" />
        </div>

        <BetsLedger bets={bets} clvByBet={clvByBet} />
      </main>
      <SiteFooter />
    </div>
  );
}
