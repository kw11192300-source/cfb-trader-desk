import BetsLedger from "@/components/BetsLedger";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function BetsPage() {
  const bets = await getBets();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="My Bets" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-1.5 text-xs text-muted">
          <p>
            Every bet actually placed, real money tracked here. Win/loss/push/profit are computed live against each game&apos;s current
            state — never stored, so a result can never go stale. <span className="text-foreground">Source</span> flags whether the bet came
            from the model&apos;s own edge, a market/line-move read, or both agreeing (the confluence case).
          </p>
        </div>
        <BetsLedger bets={bets} />
      </main>

      <SiteFooter />
    </div>
  );
}
