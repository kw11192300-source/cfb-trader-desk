import BetsLedger from "@/components/BetsLedger";
import BreakdownTable from "@/components/BreakdownTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { byMarket, byPlayer, byPropType, byPropVsCore } from "@/lib/betBreakdown";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NflBetsPage() {
  const allBets = await getBets();
  const nflBets = allBets.filter((b) => b.bet.sport === "nfl");
  const graded = nflBets.filter((b) => b.status !== "pending");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bets" sport="nfl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Every NFL bet actually placed, real money tracked here. Spread/ML/total grade live off ESPN&apos;s final score, same as
          CFB — props have no auto-grading path (no player-stats feed exists), so settle those yourself with the Settle column
          below.
        </p>

        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="Player Props vs. Core 3" rows={byPropVsCore(graded)} labelHeader="Type" />
          <BreakdownTable title="By Market" rows={byMarket(graded)} labelHeader="Market" />
        </div>
        <div className="mb-5 grid gap-5 md:grid-cols-2">
          <BreakdownTable title="By Player (props only)" rows={byPlayer(graded)} labelHeader="Player" />
          <BreakdownTable title="By Prop Type" rows={byPropType(graded)} labelHeader="Prop Type" />
        </div>

        <BetsLedger bets={nflBets} showSettle />
      </main>

      <SiteFooter />
    </div>
  );
}
