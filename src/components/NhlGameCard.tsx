import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import LogBetForm from "./LogBetForm";
import LogPropBetForm from "./LogPropBetForm";
import type { GradedBet } from "@/lib/data";
import { balancedTotal, fairMoneyline, fairOdds, pct, puckLineCover } from "@/lib/nhlModel";
import type { Bet, Game, NhlGameXg, NhlPrediction } from "@/lib/types";

/** Spreads only: "+" means this side is getting points (underdog) - same
 * convention as NflGameCard, "spread" here just means the puck line. */
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

/** Game-level P/L + ROI next to FINAL, settled bets only - mirrors
 * NflGameCard's gameSummary exactly. */
function gameSummary(bets: GradedBet[]): { profit: number; roi: number } | null {
  const settled = bets.filter((b) => b.status !== "pending");
  if (settled.length === 0) return null;
  const profit = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const staked = settled.reduce((s, b) => s + b.bet.stake, 0);
  return { profit, roi: staked > 0 ? (profit / staked) * 100 : 0 };
}

/** No odds/model for NHL yet (see sync_nhl_espn.py) - this is purely a
 * schedule + score card with a log-bet control per market, same shape as
 * NflGameCard. `week` here is a season-relative bucket (see
 * sync_nhl_espn.py's docstring), not a real "week 1/2/3" the way CFB/NFL
 * have - shown the same way regardless, since the Board/WeekTabs code
 * doesn't need to know the difference. */
const STATUS_CLASS: Record<string, string> = { win: "text-up", loss: "text-down", push: "text-muted", pending: "text-muted" };

function fmtStakeOrResult({ status, profit, bet }: GradedBet): string {
  if (status === "win" || status === "loss") return `${(profit ?? 0) >= 0 ? "+" : ""}${(profit ?? 0).toFixed(2)}u`;
  return `${bet.stake.toFixed(2)}u`;
}

export default function NhlGameCard({ game, bets = [], prediction = null, xg = null }: { game: Game; bets?: GradedBet[]; prediction?: NhlPrediction | null; xg?: NhlGameXg | null }) {
  const teamOptions = [
    { value: game.away_team, label: game.away_team },
    { value: game.home_team, label: game.home_team },
  ];
  const summary = game.completed ? gameSummary(bets) : null;
  // Model win probability only makes sense before the game starts.
  const showModel = prediction !== null && !game.completed && !game.live_status;
  const fair = showModel ? fairMoneyline(prediction.market) : null;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface">
    <Link href={`/nhl/games/${game.id}`} className="flex flex-col gap-3 rounded-t-lg p-4 transition-colors hover:bg-surface-raised">
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
          {showModel && <span className="font-mono text-xs text-accent">{pct(1 - prediction.p_home, 0)} <span className="text-muted">{fairOdds(1 - prediction.p_home)}</span></span>}
          {game.completed && game.away_points !== null && (
            <span className={`font-mono ${(game.away_points ?? 0) > (game.home_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.away_points}
              {xg?.away_xg != null && <span className="ml-2 text-[10px] font-normal text-muted">xG {xg.away_xg.toFixed(2)}</span>}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-foreground">{game.live_status.away_points}</span>}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-foreground">{game.home_team}</span>
          {showModel && <span className="font-mono text-xs text-accent">{pct(prediction.p_home, 0)} <span className="text-muted">{fairOdds(prediction.p_home)}</span></span>}
          {game.completed && game.home_points !== null && (
            <span className={`font-mono ${(game.home_points ?? 0) > (game.away_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.home_points}
              {xg?.home_xg != null && <span className="ml-2 text-[10px] font-normal text-muted">xG {xg.home_xg.toFixed(2)}</span>}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-foreground">{game.live_status.home_points}</span>}
        </div>
      </div>

      {showModel && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-border pt-2 font-mono text-[11px] text-muted">
          <span>
            exp {prediction.exp_away.toFixed(1)}–{prediction.exp_home.toFixed(1)} · tot {prediction.exp_total.toFixed(1)}
          </span>
          <span>
            {game.home_team.split(" ").slice(-1)[0]} -1.5 {pct(puckLineCover(prediction.margin_dist, "home", -1.5), 0)} ({fairOdds(puckLineCover(prediction.margin_dist, "home", -1.5))})
            {fair ? ` · DK ${pct(fair.home, 0)}` : ""}
          </span>
          <span className="w-full">
            {(() => {
              const t = balancedTotal(prediction.total_dist);
              return (
                <>
                  total {t.line % 1 === 0 ? t.line.toFixed(0) : t.line.toFixed(1)}: o {pct(t.over, 0)} ({fairOdds(t.over)}) / u {pct(t.under, 0)} ({fairOdds(t.under)})
                </>
              );
            })()}
          </span>
        </div>
      )}
    </Link>

    <div className="flex flex-col gap-3 px-4 pb-4">
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
        <LogBetForm gameId={game.id} modelVersion={null} market="spread" sideOptions={teamOptions} line={0} buttonLabel="Puck Line" defaultEdgeSource="market" sport="nhl" />
        <LogBetForm gameId={game.id} modelVersion={null} market="moneyline" sideOptions={teamOptions} line={0} buttonLabel="ML" defaultEdgeSource="market" sport="nhl" />
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
          sport="nhl"
        />
        <LogPropBetForm gameId={game.id} sport="nhl" />
      </div>
    </div>
    </div>
  );
}
