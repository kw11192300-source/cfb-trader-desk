import NhlGoalieStatsTable from "@/components/NhlGoalieStatsTable";
import NhlStatControls from "@/components/NhlStatControls";
import NhlRefreshButton from "@/components/NhlRefreshButton";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import type { StatRow } from "@/components/StatTable";
import { getNhlRefreshStatus } from "@/lib/actions";
import { nhlLogoUrl } from "@/lib/nhlTeams";
import GoalieAvailability from "@/components/GoalieAvailability";
import { getNhlGoalieStats, getNhlStatSeasons, getNhlStatsUpdated, getNhlUnavailableGoalies } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlGoaliesPage({ searchParams }: { searchParams: Promise<{ season?: string; scope?: string }> }) {
  const params = await searchParams;
  const [{ seasons, hasL10 }, updated, refreshStatus] = await Promise.all([getNhlStatSeasons(), getNhlStatsUpdated(), getNhlRefreshStatus()]);
  const requested = Number(params.season);
  const season = seasons.includes(requested) ? requested : (seasons[0] ?? 0);
  const scope = params.scope === "l10" && hasL10[season] ? "l10" : "all";
  const [data, unavailable] = await Promise.all([seasons.length > 0 ? getNhlGoalieStats(season, scope) : Promise.resolve([]), getNhlUnavailableGoalies()]);
  const goalieOptions = data
    .filter((r) => r.scope === "all" || scope === "all")
    .map((r) => ({ id: r.goalie_id, name: r.name ?? String(r.goalie_id), team: r.team, gp: r.stats.gp ?? 0 }))
    .sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || b.gp - a.gp)
    .map(({ id, name, team }) => ({ id, name, team }));
  const rows: StatRow[] = data.map((r) => ({ id: r.goalie_id, label: r.name ?? String(r.goalie_id), sub: r.team ?? undefined, logo: nhlLogoUrl(r.team), stats: r.stats }));
  const maxGp = Math.max(0, ...rows.map((r) => r.stats.gp ?? 0));
  const minDefault = scope === "l10" ? 3 : Math.min(10, Math.ceil(maxGp * 0.25));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Goalies" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            <span className="text-foreground">GSAx</span> (goals saved above expected) = the expected goals on the unblocked attempts a goalie faced, minus the goals
            that went in. Positive means he stopped more than an average goalie would have on the same chances; GSAx/100 puts it per 100 attempts so a backup with
            few games compares fairly with a starter. Empty-net goals and shootouts are excluded, and a goalie&apos;s team is the one he played for most that season.
          </p>
          <p className="mt-2">
            Small samples are mostly noise - a goalie needs a few hundred attempts before GSAx says much (use the Min GP box to hide the rest). Model rating is the
            same idea after time-decay and heavy shrinkage toward average, and is what the game simulator uses.
          </p>
        </div>

        <GoalieAvailability goalies={goalieOptions} current={unavailable} />

        <NhlRefreshButton lastPublished={updated} initial={refreshStatus} variant="tables" />

        {seasons.length > 0 && <NhlStatControls basePath="/nhl/goalies" seasons={seasons} season={season} scope={scope} hasL10={Boolean(hasL10[season])} />}
        <NhlGoalieStatsTable key={`${season}-${scope}`} rows={rows} minDefault={minDefault} />
      </main>

      <SiteFooter />
    </div>
  );
}
