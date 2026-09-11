import CornerBrackets from "@/components/CornerBrackets";
import FreshnessBanner from "@/components/FreshnessBanner";
import LiveRefresher from "@/components/LiveRefresher";
import LiveTicker from "@/components/LiveTicker";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import StatTile from "@/components/StatTile";
import TraderBoard from "@/components/TraderBoard";
import WeekTabs from "@/components/WeekTabs";
import { getAvailableWeeks, getBets, getBoard, getCurrentWeek, getLineHistoryForGames } from "@/lib/data";
import { mergeLines, mostRecentFetch } from "@/lib/mergedLines";

// Odds change throughout the week (poll_lines.py updates them every few
// minutes) — this page must never serve a cached/stale render.
export const dynamic = "force-dynamic";

function seasonTypeLabel(seasonType: string): string {
  return seasonType === "postseason" ? "Postseason" : "Regular Season";
}

export default async function Home({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const current = await getCurrentWeek();

  // Bare "/" (no ?week=) always means "current week," on every visit -
  // never remembers a previously-viewed week. A specific week is only
  // ever shown because the URL itself asked for one (via WeekTabs' links,
  // or a bookmarked/shared URL).
  const requestedWeek = params.week ? Number(params.week) : NaN;
  const board =
    current && Number.isFinite(requestedWeek) && requestedWeek !== current.week
      ? await getBoard(current.season, requestedWeek, current.seasonType)
      : await getBoard();

  const weeks = current ? await getAvailableWeeks(current.season) : [];
  const freshestFetch = mostRecentFetch((board?.rows ?? []).flatMap((r) => mergeLines(r.lines, r.oddsApiLines)));

  // KPI strip - scoped to this week's board only, same "pending = stake
  // risked, not yet settled" definition BetsLedger/RiskDashboard use.
  const games = (board?.rows ?? []).map((r) => r.game);
  const liveCount = games.filter((g) => g.live_status).length;
  const weekGameIds = new Set(games.map((g) => g.id));
  const allBets = await getBets();
  const weekPendingBets = allBets.filter((gb) => gb.bet.sport === "cfb" && gb.status === "pending" && gb.bet.game_id !== null && weekGameIds.has(gb.bet.game_id));
  const weekPendingUnits = weekPendingBets.reduce((s, gb) => s + gb.bet.stake, 0);

  // One batched line_snapshots query for every card's sparkline, not one
  // per card - a CFB week can be 200+ games.
  const lineHistory = await getLineHistoryForGames(games.map((g) => g.id));

  return (
    <div className="flex min-h-screen flex-col md:pl-16 pb-16 md:pb-0">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · ${seasonTypeLabel(board.seasonType)}` : "No active week"} />
      <LiveRefresher active={liveCount > 0} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="relative mb-4 grid grid-cols-3 gap-3 p-1">
          <CornerBrackets />
          <StatTile label="Games this week" value={`${games.length}`} />
          <StatTile label="Live now" value={`${liveCount}`} tone={liveCount > 0 ? "down" : "neutral"} />
          <StatTile
            label="Pending"
            value={`${weekPendingUnits.toFixed(2)}u`}
            tone="accent"
            sub={weekPendingBets.length > 0 ? `${weekPendingBets.length} bet${weekPendingBets.length === 1 ? "" : "s"}` : undefined}
          />
        </div>

        {current && <WeekTabs weeks={weeks} activeWeek={board?.week ?? current.week} currentWeek={current.week} />}
        <LiveTicker games={games} />
        <FreshnessBanner iso={freshestFetch} />
        <TraderBoard rows={board?.rows ?? []} lineHistory={lineHistory} />
      </main>

      <SiteFooter />
    </div>
  );
}
