import NhlRefreshButton from "@/components/NhlRefreshButton";
import NhlSkaterStatsTable, { type SkaterRow } from "@/components/NhlSkaterStatsTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlRefreshStatus } from "@/lib/actions";
import { getNhlSkaterRatings } from "@/lib/data";
import { nhlLogoUrl } from "@/lib/nhlTeams";

export const dynamic = "force-dynamic";

export default async function NhlSkatersPage() {
  const [{ rows: data, updated }, refreshStatus] = await Promise.all([getNhlSkaterRatings(), getNhlRefreshStatus()]);
  const rows: SkaterRow[] = data.map((r) => ({
    id: r.player_id,
    label: r.name ?? String(r.player_id),
    sub: [r.pos, r.team].filter(Boolean).join(" · "),
    logo: nhlLogoUrl(r.team),
    pos: r.pos,
    stats: { ...r.stats, def_good: r.stats.def === null || r.stats.def === undefined ? null : -r.stats.def },
  }));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Skaters" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every skater&apos;s <span className="text-foreground">5v5 impact on expected goals</span>, from a regularized adjusted plus-minus model fit on
            about 5,300 games of shift charts (2022 to now, recent seasons weighted more). For each stretch of a game where the same ten skaters were on the ice,
            it asks how many expected goals each team generated, and splits the credit among the players on the ice - adjusting for who they played with and
            against. Players with little ice time are pulled toward average rather than trusted.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Value/gm</span> is net impact × 5v5 minutes, so a defenseman who plays 20 minutes counts for more than a
            fourth-liner with the same per-60 rate. It is what the rank is based on and what the injury report uses to say how much a missing player matters.
          </p>
          <p className="mt-2 text-warn/90">
            Even strength only - power-play and penalty-kill value isn&apos;t included - and it measures on-ice results, not skill in a vacuum. Ratings are noisy for
            anyone with under a couple of seasons of ice time, and a linemate of a star can look better than he is. Descriptive, not a forecast.
          </p>
        </div>

        <NhlRefreshButton lastPublished={updated} initial={refreshStatus} variant="tables" />

        <NhlSkaterStatsTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
