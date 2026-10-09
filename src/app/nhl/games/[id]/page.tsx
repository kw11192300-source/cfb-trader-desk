import { notFound } from "next/navigation";
import NhlGameView from "@/components/NhlGameView";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlGame } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gameId = Number(id);
  if (!Number.isFinite(gameId)) notFound();
  const found = await getNhlGame(gameId);
  if (!found) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={`${found.game.away_team} @ ${found.game.home_team}`} sport="nhl" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <NhlGameView game={found.game} prediction={found.prediction} xg={found.xg} />
      </main>
      <SiteFooter />
    </div>
  );
}
