import EdgesTable from "@/components/EdgesTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getEdges, getInseasonEdges } from "@/lib/data";

export const dynamic = "force-dynamic";

const MODEL_VERSION = "week1_edge_v1";
const INSEASON_MODEL_VERSION = "inseason_raw_v1";

export default async function EdgesPage() {
  const [rows, inseasonRows] = await Promise.all([getEdges(MODEL_VERSION), getInseasonEdges(INSEASON_MODEL_VERSION)]);
  const generatedAt = rows.length > 0 ? rows[0].prediction.created_at : null;
  const inseasonGeneratedAt = inseasonRows.length > 0 ? inseasonRows[0].prediction.created_at : null;

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
            season not used to find this pattern). See the Backtest page for the full breakdown, including why it&apos;s FBS-only and a check
            against trivial favorite/underdog or home/away bias.
          </p>
        </div>
        <EdgesTable rows={rows} generatedAt={generatedAt} />

        <div className="mt-10 border-t border-border pt-6">
          <div className="mb-4 max-w-4xl rounded-lg border border-warn/30 bg-warn/10 p-4 text-xs">
            <p className="mb-1 font-mono font-semibold uppercase tracking-wide text-warn">Week 2+ model view — not a proven strategy</p>
            <p className="text-muted">
              The same independent-model approach, applied past week 1 (teams now have real in-season stats). Backtested walk-forward
              2016-2025, post-week-1, FBS-vs-FBS: <span className="text-foreground">51.6% ATS</span> (n=5,270) — below the 52.4% break-even line
              at standard -110 odds. A separate reframing (predicting the market&apos;s error instead of the outcome independently) was also
              tested and came back slightly worse (51.75%). Shown below for your own read, not a betting signal — sized, backed, or trusted the
              way the week-1 picks above are.
            </p>
          </div>
          <EdgesTable rows={inseasonRows} generatedAt={inseasonGeneratedAt} unvalidated />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
