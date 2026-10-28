import LogBetForm from "./LogBetForm";
import type { CbbBoardPayload } from "@/lib/types";

const sp = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const ml = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);
const half = (n: number) => Math.round(n * 2) / 2;

/** Buttons that log a spread / moneyline / total bet on one college basketball game at the line on the board right now. The board stores
 * the home MARGIN (+ = home favoured), so the home team's own spread is its negative. */
export default function CbbBetButtons({ gameId, home, away, market }: { gameId: number; home: string; away: string; market: CbbBoardPayload["market"] }) {
  const homeLine = market.cur_margin !== null ? -half(market.cur_margin) : null;
  const total = market.cur_total;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {homeLine !== null && (
        <LogBetForm
          gameId={gameId}
          sport="cbb"
          modelVersion={null}
          market="spread"
          sideOptions={[
            { value: home, label: `${home} ${sp(homeLine)}`, line: homeLine },
            { value: away, label: `${away} ${sp(-homeLine)}`, line: -homeLine },
          ]}
          line={homeLine}
          buttonLabel="Spread"
          defaultEdgeSource="model"
        />
      )}
      {(market.ml_home !== null || market.ml_away !== null) && (
        <LogBetForm
          gameId={gameId}
          sport="cbb"
          modelVersion={null}
          market="moneyline"
          sideOptions={[
            { value: home, label: `${home} ${ml(market.ml_home)}`, line: 0 },
            { value: away, label: `${away} ${ml(market.ml_away)}`, line: 0 },
          ]}
          line={0}
          buttonLabel="ML"
          defaultEdgeSource="model"
        />
      )}
      {total !== null && (
        <LogBetForm
          gameId={gameId}
          sport="cbb"
          modelVersion={null}
          market="total"
          sideOptions={[
            { value: "over", label: "Over" },
            { value: "under", label: "Under" },
          ]}
          line={total}
          buttonLabel="Total"
          defaultEdgeSource="model"
        />
      )}
    </div>
  );
}
