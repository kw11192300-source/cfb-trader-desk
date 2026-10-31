import GamesBrowser from "@/components/GamesBrowser";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getGamesWindow } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export default async function GamesPage() {
  const now = Date.now();
  const [games, { meta }] = await Promise.all([getGamesWindow(new Date(now - 4 * 86400000).toISOString(), new Date(now + 10 * 86400000).toISOString()), getExchange()]);
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="games" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Games</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every game the exchange is trading, day by day. Pick a day, filter by sport, and open a game for its markets, positions and trades. Each card shows total volume and, for the moneyline, spread and total,
          the exchange&rsquo;s price next to DraftKings&rsquo;.
        </p>
        <GamesBrowser games={games} />
      </main>
    </div>
  );
}
