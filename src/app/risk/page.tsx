import RiskDashboard from "@/components/RiskDashboard";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function RiskPage() {
  const bets = await getBets();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Risk & Portfolio" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-1.5 text-xs text-muted">
          <p>
            Current exposure covers <span className="text-foreground">pending</span> bets only. Everything else
            (P&amp;L, breakdowns, drawdown) is computed live from graded bets — never stored, so it can never go
            stale.
          </p>
        </div>
        <RiskDashboard bets={bets} />
      </main>

      <SiteFooter />
    </div>
  );
}
