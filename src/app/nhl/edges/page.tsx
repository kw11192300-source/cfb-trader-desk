import NhlEdgesTable, { type EdgeListRow } from "@/components/NhlEdgesTable";
import NhlRefreshButton from "@/components/NhlRefreshButton";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlRefreshStatus } from "@/lib/actions";
import { getNhlLastPublished, getNhlUpcomingEdgeInputs } from "@/lib/data";
import { marketEdges } from "@/lib/nhlEdges";

export const dynamic = "force-dynamic";

export default async function NhlEdgesPage() {
  const [inputs, lastPublished, refreshStatus] = await Promise.all([getNhlUpcomingEdgeInputs(), getNhlLastPublished(), getNhlRefreshStatus()]);

  const rows: EdgeListRow[] = inputs.flatMap(({ game, pred }) =>
    marketEdges(pred, game.home_team, game.away_team).map((e) => ({
      key: `${game.id}-${e.market}-${e.side}`,
      gameId: game.id,
      startDate: game.start_date,
      home: game.home_team,
      away: game.away_team,
      market: e.market,
      side: e.side,
      bookOdds: e.bookOdds,
      bookImplied: e.bookImplied,
      model: e.model,
      edgePts: e.edgePts,
      ev: e.ev,
    })),
  );
  let oddsUpdated: string | null = null;
  for (const { pred } of inputs) {
    const t = pred.market?.fetched_at;
    if (t && (!oddsUpdated || t > oddsUpdated)) oddsUpdated = t;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Edges" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every DraftKings price on an upcoming NHL game that our simulation beats, best expected value first. <span className="text-foreground">EV</span> is the
            average profit per $1 at that price if our probability is right; <span className="text-foreground">Break-even</span> is the win probability the price
            needs, vig included; <span className="text-foreground">Edge</span> is our probability minus that. Click a game for the full breakdown.
          </p>
          <p className="mt-2 text-warn/90">
            Not a betting signal. Backtested on 2021–25 this model does not beat the market&apos;s closing line, and it knows nothing about injuries, lineup
            changes or off-season roster moves - so a big number here usually means &quot;the model is missing something the market knows&quot;. Use it to find
            games worth a second look.
          </p>
        </div>

        <NhlRefreshButton lastPublished={lastPublished} oddsUpdated={oddsUpdated} initial={refreshStatus} />

        <NhlEdgesTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
