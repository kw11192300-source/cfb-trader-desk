import OddsScreenTable from "@/components/OddsScreenTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCurrentWeekBoard } from "@/lib/data";
import { mergeLines } from "@/lib/mergedLines";

export const dynamic = "force-dynamic";

export default async function OddsScreenPage() {
  const board = await getCurrentWeekBoard();
  const rows = (board?.rows ?? []).map((r) => ({
    game: r.game,
    books: mergeLines(r.lines, r.oddsApiLines),
    homeLogo: r.homeLogo,
    awayLogo: r.awayLogo,
  }));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · Odds Screen` : "Odds Screen"} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Away team on top, home team on bottom (over/under for totals) — matches the Best Price and per-book columns below. Best Price
          picks the most favorable number across every book, and breaks ties by juice (best payout wins when the point is identical).
        </p>
        <OddsScreenTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
