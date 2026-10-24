import AllSportsBets, { type DeskBet, type HistBet } from "@/components/AllSportsBets";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 86_400_000;

/** One page for the whole desk: every bet you have on a day across CFB, NFL, NHL, CBB and NBA, in game-time order. */
export default async function TodayPage() {
  const all = await getBets();
  const now = Date.now();
  const bets: DeskBet[] = [];
  // every bet ever logged, reduced to what the by-day history table needs
  const history: HistBet[] = all.map((g) => ({ t: g.game?.start_date ?? g.bet.placed_at, sport: g.bet.sport, stake: g.bet.stake, status: g.status, profit: g.profit }));
  for (const g of all) {
    const b = g.bet;
    const start = g.game?.start_date ?? null;
    const recent = start ? Math.abs(new Date(start).getTime() - now) <= WINDOW_MS : now - new Date(b.placed_at).getTime() <= WINDOW_MS;
    if (!recent && g.status !== "pending") continue;
    bets.push({
      id: b.id,
      sport: b.sport,
      market: b.market,
      side: b.side,
      player: b.player,
      propType: b.prop_type,
      legs: b.legs,
      line: b.line,
      odds: b.odds,
      stake: b.stake,
      book: b.sportsbook,
      status: g.status,
      profit: g.profit,
      placedAt: b.placed_at,
      gameId: b.game_id,
      start,
      away: g.game?.away_team ?? null,
      home: g.game?.home_team ?? null,
      completed: Boolean(g.game?.completed),
      live: Boolean(g.game?.live_status) && !g.game?.completed,
      liveDetail: g.game?.live_status?.detail ?? null,
      awayPts: g.game?.away_points ?? null,
      homePts: g.game?.home_points ?? null,
    });
  }
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="All sports · your bets by day" sport="desk" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <AllSportsBets bets={bets} history={history} />
      </main>
      <SiteFooter />
    </div>
  );
}
