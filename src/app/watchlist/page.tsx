import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import WatchlistTable from "@/components/WatchlistTable";
import { getWatchlist } from "@/lib/data";

export const dynamic = "force-dynamic";

const MODEL_VERSION = "inseason_watch_v1";

export default async function WatchlistPage() {
  const rows = await getWatchlist(MODEL_VERSION);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="In-Season Watchlist" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-2 text-xs text-muted">
          <p className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-foreground">
            <span className="font-medium text-accent">Exploratory, not validated the way the week-1 strategy is.</span>{" "}
            Once a team has played its first game, the model&apos;s raw edge on its own is roughly break-even (~53-56% ATS,
            2016-2025 backtest) — edge size alone isn&apos;t predictive post-week-1. What <em>is</em> predictive in that same
            backtest: whether the market later moves toward the model&apos;s side. A pick lands here the moment it clears a
            noise-floor edge; the line at that moment becomes its fixed reference. It only alerts once the current line has
            moved back toward the pick — that confirmed subset went 64.4% ATS vs. 41.4% when unconfirmed (n=74). Real, but a
            much thinner and more hindsight-derived result than the validated week-1 number — treat sizing here cautiously.
          </p>
        </div>
        <WatchlistTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
