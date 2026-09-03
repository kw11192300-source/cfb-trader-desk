import EdgeBacktestPanel from "@/components/EdgeBacktestPanel";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBacktestGames, getBacktestResults } from "@/lib/data";

export const dynamic = "force-dynamic";

const MODEL_VERSION = "week1_edge_v1";

export default async function BacktestPage() {
  const [backtestResults, backtestGames] = await Promise.all([getBacktestResults(MODEL_VERSION), getBacktestGames(MODEL_VERSION)]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Backtest" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-1.5 text-xs text-muted">
          <p>
            Walk-forward validation of the strategy live on the <span className="text-foreground">Edges</span> page — every season trained
            only on strictly earlier seasons, no lookahead. This is the evidence behind it, not just the claim.
          </p>
        </div>
        <EdgeBacktestPanel results={backtestResults} games={backtestGames} />
      </main>

      <SiteFooter />
    </div>
  );
}
