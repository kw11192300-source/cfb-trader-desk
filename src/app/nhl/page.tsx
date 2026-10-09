import LogParlayForm from "@/components/LogParlayForm";
import NhlGameCard from "@/components/NhlGameCard";
import NhlRefreshButton from "@/components/NhlRefreshButton";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import WeekTabs from "@/components/WeekTabs";
import { getNhlRefreshStatus } from "@/lib/actions";
import { getAvailableWeeks, getBets, getBoard, getCurrentWeek, getNhlGameXg, getNhlLastPublished, getNhlPredictions, type GradedBet } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const [current, allBets] = await Promise.all([getCurrentWeek("nhl"), getBets()]);

  const requestedWeek = params.week ? Number(params.week) : NaN;
  const board =
    current && Number.isFinite(requestedWeek) && requestedWeek !== current.week
      ? await getBoard(current.season, requestedWeek, current.seasonType, "nhl")
      : await getBoard(undefined, undefined, undefined, "nhl");

  const weeks = current ? await getAvailableWeeks(current.season, "nhl") : [];
  const games = (board?.rows ?? []).map((r) => r.game);
  const [predictions, xgByGame, lastPublished, refreshStatus] = await Promise.all([
    getNhlPredictions(games.map((g) => g.id)),
    getNhlGameXg(games.map((g) => g.id)),
    getNhlLastPublished(),
    getNhlRefreshStatus(),
  ]);

  // newest time any upcoming game's DraftKings line was read (full refresh or the odds-only button)
  let oddsUpdated: string | null = null;
  for (const p of predictions.values()) {
    const t = p.market?.fetched_at;
    if (t && (!oddsUpdated || t > oddsUpdated)) oddsUpdated = t;
  }

  const betsByGame = new Map<number, GradedBet[]>();
  for (const gb of allBets) {
    if (gb.bet.sport !== "nhl" || gb.bet.game_id === null) continue;
    betsByGame.set(gb.bet.game_id, [...(betsByGame.get(gb.bet.game_id) ?? []), gb]);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Board" sport="nhl" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Schedule + live/final scores (ESPN) and a place to log and track NHL bets. Upcoming games show our simulation&apos;s win probability once it&apos;s
          been published, and finished games show our xG - click a game for the score grid, totals and puck line (a calibrated baseline to hold the market
          against, not a betting signal). Pick a market below each game to log what you actually bet, or log a parlay across multiple games below.
          &quot;Week&quot; here is a rolling ~7-day bucket, not a real NHL schedule concept - just enough structure to reuse the same Board/tabs as CFB/NFL.
        </p>

        <NhlRefreshButton lastPublished={lastPublished} oddsUpdated={oddsUpdated} initial={refreshStatus} />

        <div className="mb-4">
          <LogParlayForm sport="nhl" />
        </div>

        {current && <WeekTabs weeks={weeks} activeWeek={board?.week ?? current.week} currentWeek={current.week} basePath="/nhl" />}

        {games.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
            No NHL games synced yet — run <code className="text-foreground">python -m cfbd_ingest.sync_nhl_espn</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <NhlGameCard key={g.id} game={g} bets={betsByGame.get(g.id) ?? []} prediction={predictions.get(g.id) ?? null} xg={xgByGame.get(g.id) ?? null} />
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
