import NhlStatControls from "@/components/NhlStatControls";
import NhlTeamStatsTable from "@/components/NhlTeamStatsTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import type { StatRow } from "@/components/StatTable";
import { getNhlStatSeasons, getNhlTeamStats } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlTeamsPage({ searchParams }: { searchParams: Promise<{ season?: string; scope?: string }> }) {
  const params = await searchParams;
  const { seasons, hasL10 } = await getNhlStatSeasons();
  const requested = Number(params.season);
  const season = seasons.includes(requested) ? requested : (seasons[0] ?? 0);
  const scope = params.scope === "l10" && hasL10[season] ? "l10" : "all";
  const data = seasons.length > 0 ? await getNhlTeamStats(season, scope) : [];
  const rows: StatRow[] = data.map((r) => ({ id: r.team, label: r.name ?? r.team, sub: r.team, stats: r.stats }));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Teams" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Team results measured by <span className="text-foreground">chance quality</span>, using our own expected-goals (xG) model on every unblocked shot
            attempt. Click any column heading to sort.
          </p>
          <p className="mt-2">
            <span className="text-foreground">xPts</span> replays each game from its chances: every shot scores with probability equal to its xG, which gives
            each team a chance to win in regulation, tie after 60:00 or lose in regulation. A tie goes to overtime/shootout (winner 2 points, loser 1, treated as
            a coin flip), so <span className="font-mono text-foreground">xPts = 2 × P(win in reg) + 1.5 × P(tied after 60)</span>. Pts − xPts is the gap between
            real points and what the chances earned: finishing, goaltending, empty nets and overtime luck.
          </p>
          <p className="mt-2 text-warn/90">
            Descriptive, not a forecast. Two honest caveats from testing on 2015–2025: a team that wins tends to sit on the lead and get outshot, so single-game
            chance quality overstates how often the better-chances team actually wins; and in a first-half to second-half test, xPts did <em>not</em> predict later
            points better than real points did. Treat it as how a team&apos;s results compare to its process, not as a betting signal.
          </p>
        </div>

        {seasons.length > 0 && <NhlStatControls basePath="/nhl/teams" seasons={seasons} season={season} scope={scope} hasL10={Boolean(hasL10[season])} />}
        <NhlTeamStatsTable key={`${season}-${scope}`} rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
