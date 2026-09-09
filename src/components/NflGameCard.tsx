import LocalDateTime from "./LocalDateTime";
import LogBetForm from "./LogBetForm";
import LogPropBetForm from "./LogPropBetForm";
import type { GradedBet } from "@/lib/data";
import type { Bet, Game } from "@/lib/types";

function fmtLine(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function fmtBet(bet: Bet): string {
  if (bet.market === "prop") return `${bet.player} ${bet.side} ${fmtLine(bet.line)} ${bet.prop_type ?? ""}`.trim();
  if (bet.market === "moneyline") return `${bet.side} ML`;
  return `${bet.side} ${fmtLine(bet.line)}`;
}

/** No odds/model for NFL yet (see sync_nfl_espn.py) - this is purely a
 * schedule + score card with a log-bet control per market, unlike
 * GameCard/MyGameCard which both assume CFB's lines/predictions exist. */
export default function NflGameCard({ game, bets = [] }: { game: Game; bets?: GradedBet[] }) {
  const pendingBets = bets.filter((b) => b.status === "pending");
  const teamOptions = [
    { value: game.away_team, label: game.away_team },
    { value: game.home_team, label: game.home_team },
  ];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between text-[11px] text-muted">
        {game.completed ? (
          <span className="font-medium text-muted">FINAL</span>
        ) : game.live_status ? (
          <span className="flex items-center gap-1.5 font-medium text-down">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-down" />
            LIVE
            {game.live_status.detail && <span className="text-muted"> · {game.live_status.detail}</span>}
          </span>
        ) : (
          <LocalDateTime
            iso={game.start_date}
            options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
          />
        )}
        <span>wk {game.week}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-foreground">{game.away_team}</span>
          {game.completed && game.away_points !== null && (
            <span className={`font-mono ${(game.away_points ?? 0) > (game.home_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.away_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-foreground">{game.live_status.away_points}</span>}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-foreground">{game.home_team}</span>
          {game.completed && game.home_points !== null && (
            <span className={`font-mono ${(game.home_points ?? 0) > (game.away_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.home_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-foreground">{game.live_status.home_points}</span>}
        </div>
      </div>

      {pendingBets.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          {pendingBets.map(({ bet }) => (
            <div key={bet.id} className="flex items-center justify-between text-xs">
              <span className="font-mono text-foreground">{fmtBet(bet)}</span>
              <span className="text-muted">{bet.stake.toFixed(2)}u</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <LogBetForm gameId={game.id} modelVersion={null} market="spread" sideOptions={teamOptions} line={0} buttonLabel="Spread" defaultEdgeSource="market" sport="nfl" />
        <LogBetForm gameId={game.id} modelVersion={null} market="moneyline" sideOptions={teamOptions} line={0} buttonLabel="ML" defaultEdgeSource="market" sport="nfl" />
        <LogBetForm
          gameId={game.id}
          modelVersion={null}
          market="total"
          sideOptions={[
            { value: "over", label: "Over" },
            { value: "under", label: "Under" },
          ]}
          line={0}
          buttonLabel="Total"
          defaultEdgeSource="market"
          sport="nfl"
        />
        <LogPropBetForm gameId={game.id} sport="nfl" />
      </div>
    </div>
  );
}
