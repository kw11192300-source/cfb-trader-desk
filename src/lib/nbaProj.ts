import type { NbaPlayerProjection, NbaStatDist } from "./data";

// Browser-safe helpers for the NBA projections: turn a stored outcome distribution (ge[i] = P(stat >= k0 + i)) into over / under
// chances, the "balanced" line (the one closest to a coin flip), milestone hit rates and fair prices.

export const STAT_LABEL: Record<string, string> = {
  pts: "Points", reb: "Rebounds", ast: "Assists", tpm: "3-pointers", stl: "Steals", blk: "Blocks", tov: "Turnovers",
  pra: "Pts+Reb+Ast", pr: "Pts+Reb", pa: "Pts+Ast", ra: "Reb+Ast", stocks: "Stl+Blk",
};
export const STAT_SHORT: Record<string, string> = { pts: "PTS", reb: "REB", ast: "AST", tpm: "3PM", stl: "STL", blk: "BLK", tov: "TO", pra: "PRA", pr: "P+R", pa: "P+A", ra: "R+A", stocks: "S+B" };
export const MILESTONES: Record<string, number[]> = {
  pts: [10, 15, 20, 25, 30, 35, 40],
  reb: [4, 6, 8, 10, 12, 14],
  ast: [2, 4, 6, 8, 10, 12],
  tpm: [1, 2, 3, 4, 5],
  stl: [1, 2, 3],
  blk: [1, 2, 3],
  pra: [20, 25, 30, 35, 40, 45, 50],
};

export function dist(p: NbaPlayerProjection, key: string): NbaStatDist | undefined {
  const d = p.stats?.[key] as NbaStatDist | undefined;
  return d && Array.isArray(d.ge) ? d : undefined;
}
export function joint(p: NbaPlayerProjection): { dd: number; td: number } | undefined {
  return p.stats?._joint as { dd: number; td: number } | undefined;
}

/** P(stat >= k). Below the stored range it is ~1, above it ~0. */
export function geAt(d: NbaStatDist, k: number): number {
  if (k < d.k0) return 0.99;
  const i = k - d.k0;
  return i < d.ge.length ? d.ge[i] : 0.005;
}

/** Over / under / push chances for a book line (x.5 = no push). */
export function overUnder(d: NbaStatDist, line: number): { over: number; under: number; push: number } {
  if (line % 1 !== 0) {
    const over = geAt(d, Math.ceil(line));
    return { over, under: 1 - over, push: 0 };
  }
  const over = geAt(d, line + 1);
  const atLeast = geAt(d, line);
  return { over, under: 1 - atLeast, push: Math.max(atLeast - over, 0) };
}

/** The x.5 line whose over chance is closest to 50% (never below 0.5). */
export function balanced(d: NbaStatDist): { line: number; over: number } {
  let best = { line: 0.5, over: geAt(d, 1), gap: Infinity };
  for (let k = Math.max(1, d.k0); k < d.k0 + d.ge.length; k++) {
    const over = geAt(d, k);
    const gap = Math.abs(over - 0.5);
    if (gap < best.gap) best = { line: k - 0.5, over, gap };
  }
  return { line: best.line, over: best.over };
}

/** American price for a probability, no vig. */
export function fairOdds(p: number): string {
  const q = Math.min(Math.max(p, 0.01), 0.99);
  const v = q >= 0.5 ? Math.round((-100 * q) / (1 - q)) : Math.round((100 * (1 - q)) / q);
  return v > 0 ? `+${v}` : `${v}`;
}
export function impliedProb(american: number): number {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}
/** Expected profit per unit staked at an American price when the true chance of winning is p. */
export function ev(p: number, american: number): number {
  const win = american > 0 ? american / 100 : 100 / -american;
  return p * win - (1 - p);
}
/** Win chance implied by a two-way moneyline with the vig removed. */
export function devig(mlA: number | null | undefined, mlB: number | null | undefined): number | null {
  if (mlA === null || mlA === undefined || mlB === null || mlB === undefined) return null;
  const a = impliedProb(mlA);
  const b = impliedProb(mlB);
  return a / (a + b);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, accurate to ~1e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 + 0.5 * y : 0.5 - 0.5 * y;
}

/** How far a final margin / total typically lands from the model's number (about the closing line's own error). */
export const MARGIN_SD = 14.2;
export const TOTAL_SD = 18;

/** Chances that a normally distributed integer outcome lands above / below / on a line. `above` = outcome > line. */
export function lineProbs(mean: number, sd: number, line: number): { above: number; below: number; push: number } {
  if (line % 1 !== 0) {
    const above = 1 - normCdf((Math.floor(line) + 0.5 - mean) / sd);
    return { above, below: 1 - above, push: 0 };
  }
  const above = 1 - normCdf((line + 0.5 - mean) / sd);
  const below = normCdf((line - 0.5 - mean) / sd);
  return { above, below, push: Math.max(1 - above - below, 0) };
}

/** Expected profit per unit at an American price when you win with prob `pWin`, lose with `pLose` (the rest is a push). */
export function evWithPush(pWin: number, pLose: number, american: number): number {
  const win = american > 0 ? american / 100 : 100 / -american;
  return pWin * win - pLose;
}
