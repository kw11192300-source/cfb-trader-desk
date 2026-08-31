import { Fragment } from "react";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCurrentWeekBoard } from "@/lib/data";
import { bestHomeSpread, bestOverTotal, bestUnderTotal, formatPrice, formatSpread, mergeLines } from "@/lib/mergedLines";

export const dynamic = "force-dynamic";

export default async function OddsScreenPage() {
  const board = await getCurrentWeekBoard();
  const rows = board?.rows ?? [];

  const merged = rows.map((r) => ({ game: r.game, books: mergeLines(r.lines, r.oddsApiLines) }));

  // Union of every book showing up anywhere this week, in preferred order
  // (mergeLines already sorts each row — flatten and dedupe by key).
  const seen = new Map<string, string>();
  for (const { books } of merged) {
    for (const b of books) if (!seen.has(b.bookKey)) seen.set(b.bookKey, b.bookName);
  }
  const bookKeys = Array.from(seen.keys());

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · Odds Screen` : "Odds Screen"} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Every book&apos;s current spread / total (with juice, where available), side by side. Green = best number on the board for that side.
        </p>

        {merged.length === 0 || bookKeys.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No lines available yet this week.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-10 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                  {bookKeys.map((key) => (
                    <th key={key} colSpan={2} className="border-l border-border px-4 py-3 text-center font-medium">
                      {seen.get(key)}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-border bg-surface-raised text-left text-[10px] uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-10 bg-surface-raised px-4 py-1"></th>
                  {bookKeys.map((key) => (
                    <Fragment key={key}>
                      <th className="border-l border-border px-4 py-1 text-center font-normal">Spread</th>
                      <th className="px-4 py-1 text-center font-normal">Total</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {merged.map(({ game, books }) => {
                  const byBook = new Map(books.map((b) => [b.bookKey, b]));
                  const bestSpread = bestHomeSpread(books);
                  const bestOver = bestOverTotal(books);
                  const bestUnder = bestUnderTotal(books);

                  return (
                    <tr key={game.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                      <td className="sticky left-0 z-10 bg-background px-4 py-3 whitespace-nowrap">
                        <Link href={`/games/${game.id}`} className="text-foreground hover:text-accent">
                          {game.away_team} @ {game.home_team}
                        </Link>
                      </td>
                      {bookKeys.map((key) => {
                        const b = byBook.get(key);
                        const isBestSpread = b && bestSpread !== null && b.homeSpread === bestSpread;
                        const isBestTotal = b && b.total !== null && (b.total === bestOver || b.total === bestUnder);
                        return (
                          <Fragment key={key}>
                            <td className={`border-l border-border px-4 py-3 text-center font-mono whitespace-nowrap ${isBestSpread ? "text-up" : "text-foreground"}`}>
                              {b ? formatSpread(game.home_team, game.away_team, b.homeSpread) : "—"}
                              {b?.homeSpreadPrice !== null && b?.homeSpreadPrice !== undefined && (
                                <span className="text-muted"> ({formatPrice(b.homeSpreadPrice)})</span>
                              )}
                            </td>
                            <td className={`px-4 py-3 text-center font-mono whitespace-nowrap ${isBestTotal ? "text-up" : "text-foreground"}`}>
                              {b?.total !== null && b?.total !== undefined ? b.total.toFixed(1) : "—"}
                              {b?.overPrice !== null && b?.overPrice !== undefined && (
                                <span className="text-muted"> (o{formatPrice(b.overPrice)})</span>
                              )}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
