import { Fragment } from "react";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCurrentWeekBoard } from "@/lib/data";
import { bestSpread, bestTotal, formatSpread, normalizeProviderName, realBookLines, sortLines } from "@/lib/lines";
import type { BettingLine } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function OddsScreenPage() {
  const board = await getCurrentWeekBoard();
  const rows = board?.rows ?? [];

  // Union of every real book showing up anywhere this week, in preferred order.
  const allLines = rows.flatMap((r) => realBookLines(r.lines));
  const bookNames = Array.from(new Set(sortLines(allLines).map((l) => normalizeProviderName(l.provider))));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={board ? `${board.season} · Week ${board.week} · Odds Screen` : "Odds Screen"} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <p className="mb-4 text-xs text-muted">
          Every book&apos;s current spread / total, side by side. Green = best number on the board for that side.
        </p>

        {rows.length === 0 || bookNames.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No lines available yet this week.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-10 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                  {bookNames.map((book) => (
                    <th key={book} colSpan={2} className="border-l border-border px-4 py-3 text-center font-medium">
                      {book}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-border bg-surface-raised text-left text-[10px] uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-10 bg-surface-raised px-4 py-1"></th>
                  {bookNames.map((book) => (
                    <Fragment key={book}>
                      <th className="border-l border-border px-4 py-1 text-center font-normal">Spread</th>
                      <th className="px-4 py-1 text-center font-normal">Total</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ game, lines }) => {
                  const real = realBookLines(lines);
                  const byBook = new Map(real.map((l) => [normalizeProviderName(l.provider), l] as [string, BettingLine]));
                  const bestHome = bestSpread(real, "home");
                  const bestOver = bestTotal(real, "over");
                  const bestUnder = bestTotal(real, "under");

                  return (
                    <tr key={game.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                      <td className="sticky left-0 z-10 bg-inherit px-4 py-3 whitespace-nowrap">
                        <Link href={`/games/${game.id}`} className="text-foreground hover:text-accent">
                          {game.away_team} @ {game.home_team}
                        </Link>
                      </td>
                      {bookNames.map((book) => {
                        const line = byBook.get(book);
                        const isBestSpread = line && bestHome && line.spread === bestHome.spread;
                        const isBestTotal = line && ((bestOver && line.over_under === bestOver.over_under) || (bestUnder && line.over_under === bestUnder.over_under));
                        return (
                          <Fragment key={book}>
                            <td className={`border-l border-border px-4 py-3 text-center font-mono whitespace-nowrap ${isBestSpread ? "text-up" : "text-foreground"}`}>
                              {line ? formatSpread(game.home_team, game.away_team, line.spread) : "—"}
                            </td>
                            <td className={`px-4 py-3 text-center font-mono ${isBestTotal ? "text-up" : "text-foreground"}`}>
                              {line?.over_under !== null && line?.over_under !== undefined ? line.over_under.toFixed(1) : "—"}
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
