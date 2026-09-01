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
        <p className="mb-4 text-xs text-muted">
          CFB Trader Desk&apos;s own power ratings, fit from historical scoring margins and play-level efficiency (PPA) —
          not sourced from any outside site. Offense and defense are separately estimated per team, Overall is their sum.
          Updated daily from completed games (FBS + FCS).
        </p>
        <RatingsTable rows={rows} />
      </main>

      <SiteFooter />
    </div>
  );
}
