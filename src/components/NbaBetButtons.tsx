import LogBetForm from "./LogBetForm";
import LogPropBetForm from "./LogPropBetForm";
import type { NbaSnapshot } from "@/lib/data";
import { nbaShort } from "@/lib/nbaTeams";
import type { Game } from "@/lib/types";

const sp = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);
const ml = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);

/** The buttons that log a spread / moneyline / total / prop bet on one NBA game at the current line. */
export default function NbaBetButtons({ game, cur }: { game: Game; cur: NbaSnapshot | null }) {
  const homeLine = cur?.spread_home_line ?? null; // the home team's own number (negative = favoured)
  const total = cur?.total_line ?? null;
  const homeShort = nbaShort(game.home_team);
  const awayShort = nbaShort(game.away_team);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <LogBetForm
        gameId={game.id}
        sport="nba"
        modelVersion={null}
        market="spread"
        sideOptions={[
          { value: game.home_team, label: `${homeShort} ${sp(homeLine)}`, line: homeLine ?? 0 },
          { value: game.away_team, label: `${awayShort} ${homeLine !== null ? sp(-homeLine) : ""}`, line: homeLine !== null ? -homeLine : 0 },
        ]}
        line={homeLine ?? 0}
        buttonLabel="Spread"
        defaultEdgeSource="market"
      />
      <LogBetForm
        gameId={game.id}
        sport="nba"
        modelVersion={null}
        market="moneyline"
        sideOptions={[
          { value: game.home_team, label: `${homeShort} ${ml(cur?.ml_home)}`, line: 0 },
          { value: game.away_team, label: `${awayShort} ${ml(cur?.ml_away)}`, line: 0 },
        ]}
        line={0}
        buttonLabel="ML"
        defaultEdgeSource="market"
      />
      <LogBetForm
        gameId={game.id}
        sport="nba"
        modelVersion={null}
        market="total"
        sideOptions={[
          { value: "over", label: "Over" },
          { value: "under", label: "Under" },
        ]}
        line={total ?? 0}
        buttonLabel="Total"
        defaultEdgeSource="market"
      />
      <LogPropBetForm gameId={game.id} sport="nba" />
    </div>
  );
}
