import BetsLedger from "@/components/BetsLedger";
import NflGameCard from "@/components/NflGameCard";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets, getUpcomingGames } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NflPage() {
  const [games, allBets] = await Promise.all([getUpcomingGames("nfl"), getBets()]);
  const nflBets = allBets.filter((b) => b.game?.sport === "nfl");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Bet Tracker" sport="nfl" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Schedule + live/final scores only (ESPN) — no odds or model yet, just a place to log and track NFL bets. Pick a market
          below each game to log what you actually bet.
        </p>

        {games.length === 0 ? (
          <div className="mb-8 rounded-lg border border-border bg-surface p-8 text-center text-muted">
            No NFL games synced yet — run <code className="text-foreground">python -m cfbd_ingest.sync_nfl_espn</code>.
          </div>
        ) : (
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <NflGameCard key={g.id} game={g} />
            ))}
          </div>
        )}

        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">NFL Bets</h2>
        <BetsLedger bets={nflBets} showSettle />
      </main>

      <SiteFooter />
    </div>
  );
}
