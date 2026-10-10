import NhlMovementTable from "@/components/NhlMovementTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlLineMovements } from "@/lib/data";

export const dynamic = "force-dynamic";

const DAYS = 14;

export default async function NhlMovementPage() {
  const rows = await getNhlLineMovements(DAYS);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Line moves" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every time DraftKings moved a moneyline, puck line or total price, newest first - what it was, what it is now, and how far it went. Prices are
            checked every ~10 minutes, so a move is stamped when we <span className="text-foreground">saw</span> it, not the exact second it happened.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Move</span> is the change in that side&apos;s implied probability (green = the side got more likely, i.e. the price
            shortened; red = it drifted), or the change in the number for a line move. <span className="text-foreground">Size</span> is the price change in
            cents. The last {DAYS} days are kept here; the full history for one game is on its page.
          </p>
        </div>

        <NhlMovementTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
