import BetsLedger from "@/components/BetsLedger";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NflBetsPage() {
  const allBets = await getBets();
  const nflBets = allBets.filter((b) => b.game?.sport === "nfl");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bets" sport="nfl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Every NFL bet actually placed, real money tracked here. Spread/ML/total grade live off ESPN&apos;s final score, same as
          CFB — props have no auto-grading path (no player-stats feed exists), so settle those yourself with the Settle column
          below.
        </p>
        <BetsLedger bets={nflBets} showSettle />
      </main>

      <SiteFooter />
    </div>
  );
}
