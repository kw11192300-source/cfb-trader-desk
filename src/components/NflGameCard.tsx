import LocalDateTime from "./LocalDateTime";
import LogBetForm from "./LogBetForm";
import LogPropBetForm from "./LogPropBetForm";
import type { GradedBet } from "@/lib/data";
import type { Bet, Game } from "@/lib/types";

/** Spreads only: "+" means this side is getting points (underdog). */
function fmtSpreadLine(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

/** Props and totals: just a number/threshold, no sign - a "+" here would
 * misleadingly read like a spread. */
function fmtLine(n: number): string {
  return n.toFixed(1);
}

function fmtBet(bet: Bet): string {
  if (bet.market === "prop") return `${bet.player} ${bet.side} ${fmtLine(bet.line)} ${bet.prop_type ?? ""}`.trim();
  if (bet.market === "moneyline") return `${bet.side} ML`;
  if (bet.market === "total") return `${bet.side} ${fmtLine(bet.line)}`;
  return `${bet.side} ${fmtSpreadLine(bet.line)}`;
}

function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** Game-level P/L + ROI next to FINAL, settled bets only (mirrors the
 * rest of the app's "staked = finished bets only" convention) - null when
 * there's nothing settled yet to summarize (no bets, or all still pending
 * props/parlays on an otherwise-finished game). */
function gameSummary(bets: GradedBet[]): { profit: number; roi: number } | null {
  const settled = bets.filter((b) => b.status !== "pending");
  if (settled.length === 0) return null;
  const profit = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const staked = settled.reduce((s, b) => s + b.bet.stake, 0);
  return { profit, roi: staked > 0 ? (profit / staked) * 100 : 0 };
}

/** No odds/model for NFL yet (see sync_nfl_espn.py) - this is purely a
 * schedule + score card with a log-bet control per market, unlike
 * GameCard/MyGameCard which both assume CFB's lines/predictions exist. */
const STATUS_CLASS: Record<string, string> = { win: "text-up", loss: "text-down", push: "text-muted", pending: "text-muted" };

/** Stake column: pending/push show the flat stake risked; a settled
 * win/loss shows the actual result (profit or -stake) instead, so the
 * card reads as "what happened" once a bet is graded, not just "what was
 * risked". */
function fmtStakeOrResult({ status, profit, bet }: GradedBet): string {
  if (status === "win" || status === "loss") return `${(profit ?? 0) >= 0 ? "+" : ""}${(profit ?? 0).toFixed(2)}u`;
  return `${bet.stake.toFixed(2)}u`;
}

export default function NflGameCard({ game, bets = [] }: { game: Game; bets?: GradedBet[] }) {
  const teamOptions = [
    { value: game.away_team, label: game.away_team },
    { value: game.home_team, label: game.home_team },
  ];
  const summary = game.completed ? gameSummary(bets) : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between text-[11px] text-muted">
        {game.completed ? (
          <span className="flex items-center gap-1.5 font-medium text-muted">
            FINAL
            {summary && (
              <span className={summary.profit >= 0 ? "text-up" : "text-down"}>
                {summary.profit >= 0 ? "+" : ""}
                {summary.profit.toFixed(2)}u ({summary.roi >= 0 ? "+" : ""}
                {summary.roi.toFixed(1)}%)
              </span>
            )}
          </span>
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

      {bets.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          {bets.map((gb) => (
            <div key={gb.bet.id} className={`flex items-center justify-between text-xs ${STATUS_CLASS[gb.status]}`}>
              <span className="font-mono">
                {fmtBet(gb.bet)}
                {gb.status === "pending" && <span className="text-muted/60"> {fmtOdds(gb.bet.odds)}</span>}
              </span>
              <span>{fmtStakeOrResult(gb)}</span>
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
