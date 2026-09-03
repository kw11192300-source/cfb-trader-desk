import FuturesTable from "@/components/FuturesTable";
import LocalDateTime from "@/components/LocalDateTime";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getSeasonFutures } from "@/lib/data";

export const dynamic = "force-dynamic";

const MODEL_VERSION = "season_sim_v1";

export default async function FuturesPage() {
  const season = new Date().getFullYear();
  const rows = await getSeasonFutures(season, MODEL_VERSION);
  const generatedAt = rows.length > 0 ? rows[0].computed_at : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Season Futures" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-2 text-xs text-muted">
          <p className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-foreground">
            <span className="font-medium text-accent">Exploratory, not validated.</span> This runs a Monte Carlo
            simulation of the rest of the season off the site&apos;s power ratings — not the validated week-1 spread
            model, which is scoped to single week-1 games and doesn&apos;t chain across a season. The playoff field is
            a simplified proxy (highest-rated team per conference stands in for &quot;conference champion,&quot; no
            real championship games or committee judgment simulated), and there&apos;s no backtest yet against real
            past seasons. Treat these numbers as directional context, not a betting signal, until that changes.
          </p>
          <p>
            <span className="text-foreground">Title %</span> compares the model&apos;s simulated championship
            probability against the market&apos;s devigged implied probability (The Odds API&apos;s national
            championship futures market) — <span className="text-foreground">Edge</span> is the gap between them, in
            percentage points. Win totals and playoff odds are model-only; no futures feed exists for those markets
            to compare against, but sportsbooks do post win totals you can check by eye.
          </p>
        </div>
        {generatedAt && (
          <p className="mb-3 text-xs text-muted">
            Generated <LocalDateTime iso={generatedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          </p>
        )}
        <FuturesTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
