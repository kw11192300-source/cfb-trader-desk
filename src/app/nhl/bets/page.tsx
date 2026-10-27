import BetsLedger from "@/components/BetsLedger";
import BreakdownTable from "@/components/BreakdownTable";
import PnlChart from "@/components/PnlChart";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { byMarket, byPlayer, byPropType, byPropVsCore } from "@/lib/betBreakdown";
import { getBets, getNhlMarkets } from "@/lib/data";
import { nhlBetClv, type Clv } from "@/lib/nhlBetClv";

export const dynamic = "force-dynamic";

export default async function NhlBetsPage() {
  const allBets = await getBets({ sport: "nhl" });
  const nhlBets = allBets.filter((b) => b.bet.sport === "nhl");
  const graded = nhlBets.filter((b) => b.status !== "pending");

  // closing-line value: each bet against DraftKings' last price we saw for that market (the close once the game has started)
  const markets = await getNhlMarkets([...new Set(nhlBets.map((b) => b.bet.game_id).filter((id): id is number => id !== null))]);
  const clvByBet: Record<number, Clv | null> = {};
  for (const b of nhlBets) clvByBet[b.bet.id] = b.bet.game_id === null ? null : nhlBetClv(b.bet, b.game, markets.get(b.bet.game_id) ?? null);
  const priceClv = nhlBets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "%");
  const lineClv = nhlBets.map((b) => clvByBet[b.bet.id]).filter((c): c is Clv => c !== null && c.unit === "pts");
  const avgClv = priceClv.length ? priceClv.reduce((s, c) => s + c.value, 0) / priceClv.length : null;
  const beat = [...priceClv, ...lineClv].filter((c) => c.value > 0).length;
  const sampled = priceClv.length + lineClv.length;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bets" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Every NHL bet actually placed, real money tracked here. Spread (puck line)/ML/total grade live off ESPN&apos;s final
          score, same as CFB/NFL — props have no auto-grading path (no player-stats feed exists), so settle those yourself with
          the Settle column below.
        </p>

        {sampled > 0 && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Avg. closing-line value</div>
              <div className={`font-mono text-lg font-semibold ${avgClv === null ? "text-foreground" : avgClv >= 0 ? "text-up" : "text-down"}`}>
                {avgClv === null ? "—" : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)} pts`}
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
              CLV compares what you got with the last DraftKings price we saw (the close once the game starts). Betting a different book&apos;s price still
              works as a yardstick, but their vig differs. It settles far faster than wins and losses - a steady positive number is the sign of a real edge.
              Only bets on games tracked since Oct 9 have a close.
            </div>
          </div>
        )}

        <div className="mb-5">
          <PnlChart bets={nhlBets} />
        </div>

        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="Player Props vs. Core 3" rows={byPropVsCore(graded)} labelHeader="Type" />
          <BreakdownTable title="By Market" rows={byMarket(graded)} labelHeader="Market" />
        </div>
        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="By Player (props only)" rows={byPlayer(graded)} labelHeader="Player" />
          <BreakdownTable title="By Prop Type" rows={byPropType(graded)} labelHeader="Prop Type" />
        </div>

        <BetsLedger bets={nhlBets} showSettle clvByBet={clvByBet} />
      </main>

      <SiteFooter />
    </div>
  );
}
