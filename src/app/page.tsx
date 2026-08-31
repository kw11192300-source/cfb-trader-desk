import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import TraderBoard from "@/components/TraderBoard";
import { getCurrentWeekBoard } from "@/lib/data";

// Odds change throughout the week (poll_lines.py updates them every few
// minutes) — this page must never serve a cached/stale render.
export const dynamic = "force-dynamic";

function seasonTypeLabel(seasonType: string): string {
  return seasonType === "postseason" ? "Postseason" : "Regular Season";
}

export default async function Home() {
  const board = await getCurrentWeekBoard();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · ${seasonTypeLabel(board.seasonType)}` : "No active week"} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <TraderBoard rows={board?.rows ?? []} />
      </main>

      <SiteFooter />
    </div>
  );
}
