import type { Bet, Game } from "./types";

export type BetOutcome = "win" | "loss" | "push" | "n/a";

function americanToDecimal(odds: number): number {
  return odds < 0 ? 100 / Math.abs(odds) + 1 : odds / 100 + 1;
}

/** Grades one spread/moneyline bet against a HYPOTHETICAL final margin
 * (home_points - away_points), not the game's real result - the building
 * block for "what if this game ends up X" scenario analysis. Total bets
 * can't be evaluated this way (their outcome depends on combined points,
 * not margin) - always "n/a" here, shown separately by the caller. */
export function evaluateBetAtMargin(bet: Bet, game: Game, homeMargin: number): { outcome: BetOutcome; profit: number } {
  if (bet.market === "total") return { outcome: "n/a", profit: 0 };

  let margin: number;
  if (bet.market === "moneyline") {
    // homeMargin === 0 (a tie) never happens in real CFB - callers skip it entirely.
    const sideIsHome = bet.side === game.home_team;
    const homeWon = homeMargin > 0;
    margin = (sideIsHome ? homeWon : !homeWon) ? 1 : -1;
  } else {
    const sideIsHome = bet.side === game.home_team;
    const actualMarginForSide = sideIsHome ? homeMargin : -homeMargin;
    margin = actualMarginForSide + bet.line;
  }

  if (margin > 0) return { outcome: "win", profit: bet.stake * (americanToDecimal(bet.odds) - 1) };
  if (margin < 0) return { outcome: "loss", profit: -bet.stake };
  return { outcome: "push", profit: 0 };
}

export type ScenarioRow = {
  label: string;
  netProfit: number;
  perBet: { bet: Bet; outcome: BetOutcome; profit: number }[];
};

function describeMarginRange(lo: number, hi: number, game: Game, range: number): string {
  // lo <= hi, same sign throughout (0 is always excluded by the caller - no ties in real CFB).
  if (lo > 0) {
    const open = hi >= range;
    if (open) return `${game.home_team} wins by ${lo}+`;
    return lo === hi ? `${game.home_team} wins by ${lo}` : `${game.home_team} wins by ${lo}-${hi}`;
  }
  const awayLo = -hi;
  const awayHi = -lo;
  const open = awayHi >= range;
  if (open) return `${game.away_team} wins by ${awayLo}+`;
  return awayLo === awayHi ? `${game.away_team} wins by ${awayLo}` : `${game.away_team} wins by ${awayLo}-${awayHi}`;
}

/** Sweeps a realistic range of final margins, evaluates every spread/
 * moneyline bet the caller passes in (expected: all of one user's bets on
 * ONE game) at each one, and collapses consecutive margins that produce
 * an identical combined net profit into a single labeled scenario - e.g.
 * "SMU wins by 1-3: both bets win, +2.00u." Any total bet on the same
 * game is filtered out here (different axis - combined points, not
 * margin) and should be surfaced separately by the caller. */
export function buildMarginScenarios(bets: Bet[], game: Game): ScenarioRow[] {
  const spreadOrMlBets = bets.filter((b) => b.market !== "total");
  if (spreadOrMlBets.length === 0) return [];

  const spreadLines = spreadOrMlBets.filter((b) => b.market === "spread").map((b) => Math.abs(b.line));
  const range = Math.ceil(Math.max(3, ...spreadLines, 0)) + 5;

  const rows: { margin: number; netProfit: number; perBet: { bet: Bet; outcome: BetOutcome; profit: number }[] }[] = [];
  for (let m = -range; m <= range; m++) {
    if (m === 0) continue; // no ties in real CFB
    const perBet = spreadOrMlBets.map((bet) => ({ bet, ...evaluateBetAtMargin(bet, game, m) }));
    const netProfit = perBet.reduce((s, r) => s + r.profit, 0);
    rows.push({ margin: m, netProfit, perBet });
  }

  const scenarios: ScenarioRow[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].netProfit === rows[i].netProfit) j++;
    scenarios.push({
      label: describeMarginRange(rows[i].margin, rows[j].margin, game, range),
      netProfit: rows[i].netProfit,
      perBet: rows[i].perBet,
    });
    i = j + 1;
  }
  return scenarios;
}
