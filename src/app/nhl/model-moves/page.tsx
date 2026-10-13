import NhlModelMovesTable from "@/components/NhlModelMovesTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlModelMoves } from "@/lib/data";

export const dynamic = "force-dynamic";

const DAYS = 14;

export default async function NhlModelMovesPage() {
  const rows = await getNhlModelMoves(DAYS);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Model moves" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every time our own numbers for a game changed, newest first - win probabilities and the expected total before and after, and <span className="text-foreground">why</span>.
            The reason is a goalie being confirmed, locked or switched (ESPN&apos;s expected starter changes a lot), or a model refresh that updated ratings, lineups
            and injuries.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Moved toward</span> is the side whose win probability rose and <span className="text-foreground">How far</span> is by how
            many points, with the change in the expected total underneath. <span className="text-foreground">vs DraftKings</span> says whether that change closed the
            gap to DraftKings&apos; price at that moment or opened it. The last {DAYS} days are kept; each game&apos;s page has its own chart of these changes.
          </p>
        </div>

        <NhlModelMovesTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
