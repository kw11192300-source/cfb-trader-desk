import { notFound } from "next/navigation";
import NhlGameView, { type NhlGameExtras } from "@/components/NhlGameView";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlGame, getNhlGoalieStats, getNhlOddsSnapshots, getNhlStatSeasons, getNhlTeamStats } from "@/lib/data";
import { cautions } from "@/lib/nhlContext";
import { getNhlContext } from "@/lib/nhlContextData";
import { devig } from "@/lib/nhlModel";
import { goalieLines, teamMatchup } from "@/lib/nhlMatchup";
import { goalieScenarios } from "@/lib/nhlScenarios";

export const dynamic = "force-dynamic";

export default async function NhlGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gameId = Number(id);
  if (!Number.isFinite(gameId)) notFound();
  const [found, snapshots, ctx, seasonInfo] = await Promise.all([getNhlGame(gameId), getNhlOddsSnapshots(gameId), getNhlContext(), getNhlStatSeasons()]);
  if (!found) notFound();

  // everything the model doesn't know + the tables it can be read against, only for games that have a prediction
  let extras: NhlGameExtras | undefined;
  const pred = found.prediction;
  if (pred) {
    const season = seasonInfo.seasons[0];
    const [all, l10, goalies] =
      season !== undefined
        ? await Promise.all([getNhlTeamStats(season, "all"), getNhlTeamStats(season, "l10"), getNhlGoalieStats(season, "all")])
        : [[], [], []];
    const m = pred.market;
    const mlGap = m && m.ml_home !== null && m.ml_away !== null ? Math.abs(pred.p_home - devig(m.ml_home, m.ml_away)) * 100 : null;
    const a = pred.assumptions;
    extras = {
      ctx,
      cautions: cautions({ home: found.game.home_team, away: found.game.away_team, startIso: found.game.start_date, assumptions: a, ctx, mlGapPts: mlGap }),
      scenarios: found.game.completed ? [] : goalieScenarios(pred, found.game.home_team, found.game.away_team),
      matchup: {
        lines: teamMatchup(all, l10, found.game.home_team, found.game.away_team),
        awayGoalies: goalieLines(a?.goalies.away ?? [], goalies, found.game.away_team),
        homeGoalies: goalieLines(a?.goalies.home ?? [], goalies, found.game.home_team),
      },
    };
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={`${found.game.away_team} @ ${found.game.home_team}`} sport="nhl" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <NhlGameView game={found.game} prediction={found.prediction} xg={found.xg} snapshots={snapshots} extras={extras} />
      </main>
      <SiteFooter />
    </div>
  );
}
