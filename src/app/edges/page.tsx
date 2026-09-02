import EdgesPageTabs from "@/components/EdgesPageTabs";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBacktestResults, getEdges } from "@/lib/data";

export const dynamic = "force-dynamic";

const MODEL_VERSION = "week1_edge_v1";

export default async function EdgesPage() {
  const [rows, backtestResults] = await Promise.all([getEdges(MODEL_VERSION), getBacktestResults(MODEL_VERSION)]);
  const generatedAt = rows.length > 0 ? rows[0].prediction.created_at : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Model Edges" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-1.5 text-xs text-muted">
          <p>
            Week-1-of-season, FBS-vs-FBS games only — both teams still on the preseason projection, no in-season evidence yet. Ranked by{" "}
            <span className="text-foreground">edge</span>: how far the model&apos;s predicted margin sits from what the market&apos;s current
            spread implies. <span className="text-foreground">Pick</span> is whichever side the model favors relative to the market, not a
            prediction of who wins outright.
          </p>
          <p>
            Backtested walk-forward 2016-2025 restricted to the top ~15 highest-edge games per week: 74% ATS 2016-2024, 80% on 2025 (the one
            season not used to find this pattern). See the Backtest tab for the full breakdown, including why it&apos;s FBS-only and a check
            against trivial favorite/underdog or home/away bias.
          </p>
        </div>
        <EdgesPageTabs rows={rows} generatedAt={generatedAt} backtestResults={backtestResults} />
      </main>

      <SiteFooter />
    </div>
  );
}
