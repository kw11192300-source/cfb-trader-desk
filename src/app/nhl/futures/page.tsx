import NhlFuturesTable, { type FuturesRow } from "@/components/NhlFuturesTable";
import NhlRefreshButton from "@/components/NhlRefreshButton";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlRefreshStatus } from "@/lib/actions";
import { getNhlFutures } from "@/lib/data";
import { nhlLogoUrl } from "@/lib/nhlTeams";

export const dynamic = "force-dynamic";

export default async function NhlFuturesPage() {
  const [{ rows: data, updated, season }, refreshStatus] = await Promise.all([getNhlFutures(), getNhlRefreshStatus()]);
  const rows: FuturesRow[] = data.map((r) => {
    const { conference, div_name: division, ...rest } = r.stats;
    const nums = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === "number" || v === null)) as Record<string, number | null>;
    return {
      id: r.team,
      label: r.team,
      sub: `${division}`,
      logo: nhlLogoUrl(r.team),
      conference: String(conference),
      division: String(division),
      stats: nums,
    };
  });

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={`Futures${season ? ` - ${season}-${String(season + 1).slice(2)}` : ""}`} sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every team&apos;s chance to <span className="text-foreground">win its division, make the playoffs, win each round, win the conference and win the
            Stanley Cup</span>, from playing the rest of the season and the playoff bracket 10,000 times. Each remaining game is simulated from the same
            model as the game pages (team rates, expected goalie, lineup adjustment), so points, regulation wins and overtime/shootout losses all come out right.
            The price next to each percentage is its fair American odds with no vig.
          </p>
          <p className="mt-2">
            Standings tiebreakers are points, regulation wins, regulation + overtime wins, goal differential, then a coin flip. The playoffs use the current
            format: three per division plus two wild cards, the best division winner against the lower wild card, best-of-7 with 2-2-1-1-1 home ice for the
            better record. Every team also gets a small random strength shift each simulated season, so favourites aren&apos;t treated as certain of their rating.
          </p>
          <p className="mt-2 text-warn/90">
            Checked against 2021-2025: at about 20 and 50 games in, the make-the-playoffs and win-the-division probabilities were well calibrated (320
            team-checkpoints). The later rounds and the Cup can&apos;t be checked that way, so treat them as estimates built on that foundation. Team ratings are
            the same ones the game model uses and don&apos;t know about a future trade or injury.
          </p>
        </div>

        <NhlRefreshButton lastPublished={updated} initial={refreshStatus} variant="tables" />

        <NhlFuturesTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
