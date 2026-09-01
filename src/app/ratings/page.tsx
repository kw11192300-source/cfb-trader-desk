import RatingsTable from "@/components/RatingsTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getPowerRatings } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function RatingsPage() {
  const rows = await getPowerRatings();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Power Ratings" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl space-y-1.5 text-xs text-muted">
          <p>
            CFB Trader Desk&apos;s own power ratings, fit from historical scoring margins and play-level efficiency (PPA) —
            not sourced from any outside site. FBS and FCS are fit as one linked system (real FBS-vs-FCS games tie the two
            together) but <span className="text-foreground">0 = an average FBS team</span>, so FCS ratings read correctly
            negative against that same yardstick rather than against their own separate average.
          </p>
          <p>
            <span className="text-foreground">Overall</span> is Offense (scoring) + Defense (scoring), in points. Read it as
            expected margin on a neutral field: the <em>difference</em> between two teams&apos; Overall is the model&apos;s
            predicted point spread between them (e.g. a +40 team vs a +10 team → roughly a 30-point favorite). A single
            team&apos;s number is relative to that average-FBS zero point, not a literal &quot;points per game.&quot;
          </p>
          <p>
            <span className="text-foreground">Off/Def (scoring)</span> is fit directly to actual points scored/allowed, so
            it&apos;s in real point units. <span className="text-foreground">Off/Def (eff.)</span> is the same idea fit to
            PPA (predicted points added per play) instead — a process-quality signal that&apos;s less noisy than raw
            scoring (removes garbage time, a missed extra point, a lucky bounce) but naturally lives on a much smaller
            per-play scale (typically -1 to +1), so don&apos;t compare its magnitude directly to the scoring columns — read
            each independently, and watch for cases where they disagree.
          </p>
        </div>
        <RatingsTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
