import FreshnessBanner from "@/components/FreshnessBanner";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import TraderBoard from "@/components/TraderBoard";
import WeekTabs from "@/components/WeekTabs";
import { getAvailableWeeks, getBoard, getCurrentWeek } from "@/lib/data";
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

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · ${seasonTypeLabel(board.seasonType)}` : "No active week"} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        {current && <WeekTabs weeks={weeks} activeWeek={board?.week ?? current.week} currentWeek={current.week} />}
        <FreshnessBanner iso={freshestFetch} />
        <TraderBoard rows={board?.rows ?? []} />
      </main>

      <SiteFooter />
    </div>
  );
}
