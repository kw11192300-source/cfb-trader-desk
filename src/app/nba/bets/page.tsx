import BetsLedger from "@/components/BetsLedger";
import BreakdownTable from "@/components/BreakdownTable";
import NbaScoresButton from "@/components/NbaScoresButton";
import PnlChart from "@/components/PnlChart";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { byMarket, byPlayer, byPropType, byPropVsCore } from "@/lib/betBreakdown";
import { getBets, getNbaSnapshots } from "@/lib/data";
import { nbaBetClv } from "@/lib/nbaBetClv";
import type { Clv } from "@/lib/nhlBetClv";

export const dynamic = "force-dynamic";

export default async function NbaBetsPage() {
  const allBets = await getBets();
  const nbaBets = allBets.filter((b) => b.bet.sport === "nba");
  const graded = nbaBets.filter((b) => b.status !== "pending");

  // closing-line value: each bet against the last line we logged before tip-off
  const snaps = await getNbaSnapshots([...new Set(nbaBets.map((b) => b.bet.game_id).filter((id): id is number => id !== null))]);
  const clvByBet: Record<number, Clv | null> = {};
  for (const b of nbaBets) clvByBet[b.bet.id] = b.bet.game_id === null ? null : nbaBetClv(b.bet, b.game, snaps.get(b.bet.game_id));
  const priceClv = nbaBets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "%");
  const lineClv = nbaBets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "pts");
  const avgClv = priceClv.length ? priceClv.reduce((s, c) => s + c.value, 0) / priceClv.length : null;
  const beat = [...priceClv, ...lineClv].filter((c) => c.value > 0).length;
  const sampled = priceClv.length + lineClv.length;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bets" sport="nba" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <NbaScoresButton />
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Every NBA bet actually placed. Spread, moneyline and total grade off ESPN&apos;s final score. Player props grade from the box score once the game is
          final (the Settle column shows the result and the player&apos;s number in the notes); a player who doesn&apos;t play voids the bet. First basket, quarter and
          half lines and team props are settled by you with the Settle column. You can always override an automatic result there.
        </p>

        {sampled > 0 && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Avg. closing-line value</div>
              <div className={`font-mono text-lg font-semibold ${avgClv === null ? "text-foreground" : avgClv >= 0 ? "text-up" : "text-down"}`}>
                {avgClv === null ? "—" : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}%`}
              </div>
              <div className="text-[11px] text-muted">same number, price vs the close ({priceClv.length} bets)</div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Beat the close</div>
              <div className="font-mono text-lg font-semibold text-foreground">
                {beat} of {sampled}
              </div>
              <div className="text-[11px] text-muted">better price or line than where it closed</div>
            </div>
            <div className="col-span-2 rounded-lg border border-border bg-surface px-4 py-3 text-[11px] leading-relaxed text-muted">
              CLV compares what you got with the last line we logged before tip-off. Betting a different book&apos;s price still works as a yardstick, but their vig
              differs. It settles far faster than wins and losses - a steady positive number is the sign of a real edge. Only games we logged lines for have a
              close, and player props have no closing line here.
            </div>
          </div>
        )}

        <div className="mb-5">
          <PnlChart bets={nbaBets} />
        </div>

        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="Player Props vs. Core 3" rows={byPropVsCore(graded)} labelHeader="Type" />
          <BreakdownTable title="By Market" rows={byMarket(graded)} labelHeader="Market" />
        </div>
        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="By Player (props only)" rows={byPlayer(graded)} labelHeader="Player" />
          <BreakdownTable title="By Prop Type" rows={byPropType(graded)} labelHeader="Prop Type" />
        </div>

        <BetsLedger bets={nbaBets} showSettle clvByBet={clvByBet} />
      </main>

      <SiteFooter />
    </div>
  );
}
