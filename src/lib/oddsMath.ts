/** Break-even win rate implied by American odds - the raw, still-vigged number. */
export function impliedProb(odds: number): number {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

/** Removes the vig from a two-way moneyline by normalizing both sides'
 * implied probabilities to sum to 1 - the standard way to get a
 * sportsbook's actual (de-vigged) view, comparable to a prediction
 * market's own price (which has no separate "vig" side to strip - its
 * price already reflects both sides at once). */
export function devigTwoWay(homeOdds: number, awayOdds: number): { home: number; away: number } {
  const home = impliedProb(homeOdds);
  const away = impliedProb(awayOdds);
  const total = home + away;
  return { home: home / total, away: away / total };
}
