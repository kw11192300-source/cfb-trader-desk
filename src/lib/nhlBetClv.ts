import type { NhlMarket } from "./types";
import type { Bet, Game } from "./types";

const implied = (odds: number): number => (odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100));

/** "%" = change in the implied probability of the SAME price at the same number (the usual CLV); "pts" = the number itself
 * moved in your favour, in goals (puck line or total whose line is not the one you took). */
export type Clv = { value: number; unit: "pts" | "%" };

/** Your bet against DraftKings' last price we saw (the close once the game has started, the current price before that).
 * Positive = you got a better number or price than the market ended up at. Null when we have no price for that market. */
export function nhlBetClv(bet: Bet, game: Game | null, m: NhlMarket | null): Clv | null {
  if (!game || !m) return null;
  const isHome = bet.side === game.home_team;
  const priceClv = (closeOdds: number | null): Clv | null => (closeOdds === null ? null : { value: (implied(closeOdds) - implied(bet.odds)) * 100, unit: "%" });

  if (bet.market === "moneyline" || (bet.market === "spread" && Math.abs(bet.line) === 0.5)) {
    return priceClv(isHome ? m.ml_home : m.ml_away);
  }
  if (bet.market === "spread") {
    if (m.spread_home_line === null) return null;
    const closeLine = isHome ? m.spread_home_line : -m.spread_home_line;
    if (closeLine === bet.line) return priceClv(isHome ? m.spread_home_odds : m.spread_away_odds);
    return { value: bet.line - closeLine, unit: "pts" };
  }
  if (bet.market === "total") {
    if (m.total_line === null) return null;
    if (m.total_line === bet.line) return priceClv(bet.side === "over" ? m.over_odds : m.under_odds);
    return { value: bet.side === "over" ? m.total_line - bet.line : bet.line - m.total_line, unit: "pts" };
  }
  return null;
}
