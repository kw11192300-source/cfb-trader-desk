import NhlStatControls from "@/components/NhlStatControls";
import NhlTeamStatsTable from "@/components/NhlTeamStatsTable";
import NhlRefreshButton from "@/components/NhlRefreshButton";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import type { StatRow } from "@/components/StatTable";
import { getNhlRefreshStatus } from "@/lib/actions";
import { getNhlStatSeasons, getNhlStatsUpdated, getNhlTeamStats } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlTeamsPage({ searchParams }: { searchParams: Promise<{ season?: string; scope?: string }> }) {
  const params = await searchParams;
  const [{ seasons, hasL10 }, updated, refreshStatus] = await Promise.all([getNhlStatSeasons(), getNhlStatsUpdated(), getNhlRefreshStatus()]);
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
            <span className="text-foreground">Power</span> folds the stats into one number: the goal differential per game we expect the team to post over the rest of the
            season, vs an average team. It is a sum of five pieces - even-strength xG differential, special teams, goaltending, finishing, and last season&apos;s
            xG differential (which fades as the new season fills in) - and the weights are learned from 2015–2025, not chosen by hand. Goaltending and finishing are
            heavily shrunk because they are only partly skill. Early in the season most of a team&apos;s rating is last year&apos;s; it hands over to this
            year&apos;s games as they pile up (and a hot or cold start is scaled down about 15% in the first dozen games, because out-of-sample it overshoots). Season view only (no Last 10).
          </p>
          <p className="mt-2">
            Out-of-sample check (each season predicted from a model trained on earlier ones; correlation with goal differential over the games still to come):
            after 10 games power rating 0.67 vs 0.58 for last season alone and 0.54 for score-adjusted xG differential; after 20 games 0.67 vs 0.60; after 40 games 0.65 vs
            0.63 for goal differential; after 60 games 0.61 vs 0.61 for points %. So it helps most early, and late in the year it is no better than just
            looking at the standings.
          </p>
          <p className="mt-2">
            <span className="text-foreground">xPts</span> replays each game from its chances: every shot scores with probability equal to its xG (adjusted for the
            score when it was taken, below), which gives
            each team a chance to win in regulation, tie after 60:00 or lose in regulation. A tie goes to overtime/shootout (winner 2 points, loser 1, treated as
            a coin flip), so <span className="font-mono text-foreground">xPts = 2 × P(win in reg) + 1.5 × P(tied after 60)</span>. Pts − xPts is the gap between
            real points and what the chances earned: finishing, goaltending, empty nets and overtime luck.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Score adjustment:</span> a team protecting a lead gets out-chanced and a trailing team pushes, so raw xG makes winners look
            worse than they were. Each shot&apos;s xG is reweighted by how much the average team creates in that score state (trailing by two ≈ 3.1 xG per 60,
            tied ≈ 2.7, leading by two or more ≈ 2.5) relative to a tied game. The unadjusted xPts is kept alongside for comparison.
          </p>
          <p className="mt-2 text-warn/90">
            Descriptive, not a forecast. Tested on 2015–2025: the adjustment moved the top-chances games from &quot;modelled 69% to win, actually 47%&quot; to 70% vs
            61%, and lifted a first-half → second-half points test from 0.50 to 0.53 (real points: 0.57), so xPts still did not predict later points better than
            real points did. Treat it as how a team&apos;s results compare to its process, not as a betting signal.
          </p>
        </div>

        <NhlRefreshButton lastPublished={updated} initial={refreshStatus} variant="tables" />

        {seasons.length > 0 && <NhlStatControls basePath="/nhl/teams" seasons={seasons} season={season} scope={scope} hasL10={Boolean(hasL10[season])} />}
        <NhlTeamStatsTable key={`${season}-${scope}`} rows={rows} defaultSort={scope === "all" ? "power" : "xgf_pct"} />
      </main>

      <SiteFooter />
    </div>
  );
}
