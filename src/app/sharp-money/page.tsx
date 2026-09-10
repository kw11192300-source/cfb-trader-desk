import SharpMoneyTable from "@/components/SharpMoneyTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getSharpMoneyEdges } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SharpMoneyPage() {
  const rows = await getSharpMoneyEdges();

  return (
    <div className="flex min-h-screen flex-col md:pl-16 pb-16 md:pb-0">
      <SiteHeader subtitle="Sharp Money" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-2 text-xs text-muted">
          <p className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-foreground">
            <span className="font-medium text-accent">Exploratory, not validated.</span> Ranks every game where a prediction market
            (Kalshi/Polymarket) and the sportsbook consensus (de-vigged moneyline, averaged across every book with one posted)
            disagree on win probability. A big gap on a market with real volume/liquidity behind it is the signal worth
            watching — a big gap on a market nobody&apos;s traded yet is just noise from a thin, newly-opened price. Prematch
            only; nothing here reflects live in-game pricing.
          </p>
        </div>
        <SharpMoneyTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
