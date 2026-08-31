import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import LineMovementChart from "@/components/LineMovementChart";
import LocalDateTime from "@/components/LocalDateTime";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getGame, getLineHistory } from "@/lib/data";
import { formatSpread as formatCfbdSpread } from "@/lib/lines";
import { bestHomeSpread, bestOverTotal, bestUnderTotal, formatMoneyline, formatPrice, formatSpread, mergeLines } from "@/lib/mergedLines";

export const dynamic = "force-dynamic";

function TeamLogo({ src, alt }: { src: string | null | undefined; alt: string }) {
  if (!src) return <div className="h-12 w-12 shrink-0 rounded-full bg-surface-raised" />;
  return <Image src={src} alt={alt} width={48} height={48} className="h-12 w-12 shrink-0 object-contain" unoptimized />;
}

export default async function GamePage({ params }: PageProps<"/games/[id]">) {
  const { id } = await params;
  const gameId = Number(id);
  if (!Number.isFinite(gameId)) notFound();

  const [detail, history] = await Promise.all([getGame(gameId), getLineHistory(gameId)]);
  if (!detail) notFound();

  const { game, lines, oddsApiLines, homeTeam, awayTeam } = detail;
  const books = mergeLines(lines, oddsApiLines);

  // "Open" only exists for books CFBD itself tracks (that's the only source
  // with historical open data) — look it up per book by normalized key so a
  // book that only came from The Odds API just shows "—" rather than a
  // fabricated open value.
  const cfbdOpenByKey = new Map(lines.map((l) => [l.provider.toLowerCase().replace(/[^a-z0-9]/g, ""), l]));

  const bestSpread = bestHomeSpread(books);
  const bestOver = bestOverTotal(books);
  const bestUnder = bestUnderTotal(books);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={`${game.season} · Week ${game.week}`} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
        <Link href="/" className="text-xs text-muted transition-colors hover:text-foreground">
          ← Back to board
        </Link>

        <div className="mt-4 rounded-lg border border-border bg-surface p-6">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-3">
              <TeamLogo src={awayTeam?.logo_url} alt={game.away_team} />
              <div>
                <div className="text-xs text-muted">Away</div>
                <div className="text-base font-semibold text-foreground">{game.away_team}</div>
              </div>
            </div>
            <div className="text-muted">@</div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-xs text-muted">Home</div>
                <div className="text-base font-semibold text-foreground">{game.home_team}</div>
              </div>
              <TeamLogo src={homeTeam?.logo_url} alt={game.home_team} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted sm:justify-between">
            <span>
              <LocalDateTime
                iso={game.start_date}
                options={{ weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
              />
            </span>
            {game.venue && <span>{game.venue}</span>}
            {game.neutral_site && <span className="text-accent">Neutral site</span>}
          </div>
        </div>

        <h2 className="mt-8 mb-3 text-sm font-medium uppercase tracking-wide text-muted">Odds comparison</h2>

        {books.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-muted">No lines available for this game yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[700px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-medium">Book</th>
                  <th className="px-4 py-3 font-medium">Spread</th>
                  <th className="px-4 py-3 font-medium">Open</th>
                  <th className="px-4 py-3 font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Open</th>
                  <th className="px-4 py-3 font-medium">ML (H/A)</th>
                </tr>
              </thead>
              <tbody>
                {books.map((l) => {
                  const cfbdOpen = cfbdOpenByKey.get(l.bookKey);
                  return (
                    <tr key={l.bookKey} className="border-b border-border last:border-0 odd:bg-surface/50">
                      <td className="px-4 py-3 text-foreground">{l.bookName}</td>
                      <td className={`px-4 py-3 font-mono ${l.homeSpread === bestSpread ? "text-up" : "text-foreground"}`}>
                        {formatSpread(game.home_team, game.away_team, l.homeSpread)}
                        {l.homeSpreadPrice !== null && <span className="text-muted"> ({formatPrice(l.homeSpreadPrice)})</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-muted">
                        {cfbdOpen?.spread_open != null ? formatCfbdSpread(game.home_team, game.away_team, cfbdOpen.spread_open) : "—"}
                      </td>
                      <td className={`px-4 py-3 font-mono ${l.total === bestOver || l.total === bestUnder ? "text-up" : "text-foreground"}`}>
                        {l.total !== null ? l.total.toFixed(1) : "—"}
                        {l.overPrice !== null && (
                          <span className="text-muted">
                            {" "}
                            (o{formatPrice(l.overPrice)}/u{formatPrice(l.underPrice)})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-muted">{cfbdOpen?.over_under_open != null ? cfbdOpen.over_under_open.toFixed(1) : "—"}</td>
                      <td className="px-4 py-3 font-mono text-muted">
                        {formatMoneyline(l.homeMoneyline)} / {formatMoneyline(l.awayMoneyline)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Green highlights the best number across books for that side. Prices in parentheses are the juice (e.g. -110) where available —
          The Odds API carries real per-book pricing; books sourced only from CFBD show points only.
        </p>

        <h2 className="mt-8 mb-3 text-sm font-medium uppercase tracking-wide text-muted">Line movement</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-2 text-xs text-muted">Spread</div>
            <LineMovementChart snapshots={history} field="spread" label="Spread" />
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-2 text-xs text-muted">Total</div>
            <LineMovementChart snapshots={history} field="over_under" label="Total" />
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
