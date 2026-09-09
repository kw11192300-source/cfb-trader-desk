import NflGameCard from "@/components/NflGameCard";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import WeekTabs from "@/components/WeekTabs";
import { getAvailableWeeks, getBoard, getCurrentWeek } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NflPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const current = await getCurrentWeek("nfl");

  const requestedWeek = params.week ? Number(params.week) : NaN;
  const board =
    current && Number.isFinite(requestedWeek) && requestedWeek !== current.week
      ? await getBoard(current.season, requestedWeek, current.seasonType, "nfl")
      : await getBoard(undefined, undefined, undefined, "nfl");

  const weeks = current ? await getAvailableWeeks(current.season, "nfl") : [];
  const games = (board?.rows ?? []).map((r) => r.game);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Board" sport="nfl" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Schedule + live/final scores only (ESPN) — no odds or model yet, just a place to log and track NFL bets. Pick a market
          below each game to log what you actually bet.
        </p>

        {current && <WeekTabs weeks={weeks} activeWeek={board?.week ?? current.week} currentWeek={current.week} basePath="/nfl" />}

        {games.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
            No NFL games synced yet — run <code className="text-foreground">python -m cfbd_ingest.sync_nfl_espn</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <NflGameCard key={g.id} game={g} />
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
