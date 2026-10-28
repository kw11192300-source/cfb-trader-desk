import AllSportsBets from "@/components/AllSportsBets";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { toDeskBets, toHistory } from "@/lib/deskBets";
import { getBets } from "@/lib/data";

export const dynamic = "force-dynamic";

/** One page for the whole desk: every bet you have on a day across CFB, NFL, NHL, CBB and NBA, in game-time order. */
export default async function TodayPage() {
  const all = await getBets({ withLines: false });
  const bets = toDeskBets(all, 10);
  const history = toHistory(all); // every bet ever logged, reduced to what the by-day history table needs
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="All sports · your bets by day" sport="desk" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <AllSportsBets bets={bets} history={history} />
      </main>
      <SiteFooter />
    </div>
  );
}
