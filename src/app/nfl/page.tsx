import LogParlayForm from "@/components/LogParlayForm";
import NflGameCard from "@/components/NflGameCard";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import StatTile from "@/components/StatTile";
import WeekTabs from "@/components/WeekTabs";
import { getAvailableWeeks, getBets, getBoard, getCurrentWeek, type GradedBet } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NflPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const [current, allBets] = await Promise.all([getCurrentWeek("nfl"), getBets()]);

  const requestedWeek = params.week ? Number(params.week) : NaN;
  const board =
    current && Number.isFinite(requestedWeek) && requestedWeek !== current.week
      ? await getBoard(current.season, requestedWeek, current.seasonType, "nfl")
      : await getBoard(undefined, undefined, undefined, "nfl");

  const weeks = current ? await getAvailableWeeks(current.season, "nfl") : [];
  const games = (board?.rows ?? []).map((r) => r.game);

  const betsByGame = new Map<number, GradedBet[]>();
  for (const gb of allBets) {
    if (gb.bet.sport !== "nfl" || gb.bet.game_id === null) continue;
    betsByGame.set(gb.bet.game_id, [...(betsByGame.get(gb.bet.game_id) ?? []), gb]);
  }

  // KPI strip - scoped to this week's board only (not season-wide), same
  // "pending = stake risked, not yet settled" definition BetsLedger/
  // RiskDashboard already use.
  const liveCount = games.filter((g) => g.live_status).length;
  const weekGameIds = new Set(games.map((g) => g.id));
  const weekPendingBets = [...betsByGame.values()].flat().filter((gb) => gb.status === "pending" && weekGameIds.has(gb.bet.game_id!));
  const weekPendingUnits = weekPendingBets.reduce((s, gb) => s + gb.bet.stake, 0);

  return (
    <div className="flex min-h-screen flex-col md:pl-16 pb-16 md:pb-0">
      <SiteHeader subtitle="Board" sport="nfl" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Schedule + live/final scores only (ESPN) — no odds or model yet, just a place to log and track NFL bets. Pick a market
          below each game to log what you actually bet, or log a parlay across multiple games below.
        </p>

        <div className="mb-4 grid grid-cols-3 gap-3">
          <StatTile label="Games this week" value={`${games.length}`} />
          <StatTile label="Live now" value={`${liveCount}`} tone={liveCount > 0 ? "down" : "neutral"} />
          <StatTile
            label="Pending"
            value={`${weekPendingUnits.toFixed(2)}u`}
            tone="accent"
            sub={weekPendingBets.length > 0 ? `${weekPendingBets.length} bet${weekPendingBets.length === 1 ? "" : "s"}` : undefined}
          />
        </div>

        <div className="mb-4">
          <LogParlayForm sport="nfl" />
        </div>

        {current && <WeekTabs weeks={weeks} activeWeek={board?.week ?? current.week} currentWeek={current.week} basePath="/nfl" />}

        {games.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-8 shadow-card text-center text-muted">
            No NFL games synced yet — run <code className="text-foreground">python -m cfbd_ingest.sync_nfl_espn</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <NflGameCard key={g.id} game={g} bets={betsByGame.get(g.id) ?? []} />
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
