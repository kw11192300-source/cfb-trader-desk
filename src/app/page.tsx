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
      <header className="border-b border-border bg-surface px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              CFB <span className="text-accent">Trader Desk</span>
            </h1>
            <p className="text-xs text-muted">
              {board ? `${board.season} · Week ${board.week} · ${seasonTypeLabel(board.seasonType)}` : "No active week"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-up" />
            live
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <TraderBoard rows={board?.rows ?? []} />
      </main>

      <footer className="border-t border-border px-6 py-4 text-center text-xs text-muted">
        Odds via CollegeFootballData.com · not financial or betting advice
      </footer>
    </div>
  );
}
