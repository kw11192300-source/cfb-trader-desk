import type { NhlMarket, NhlPrediction } from "./types";

/** Probability mass of a {value: probability} distribution strictly above / below / exactly at a line. */
export function overUnder(dist: Record<string, number>, line: number): { over: number; under: number; push: number } {
  let over = 0;
  let under = 0;
  let push = 0;
  for (const [k, p] of Object.entries(dist)) {
    const v = Number(k);
    if (v > line) over += p;
    else if (v < line) under += p;
    else push += p;
  }
  return { over, under, push };
}

/** The total (half or whole numbers, 4.5-7.5) whose over/under is closest to 50/50 on the final-score distribution.
 * Over and under are given excluding a push (a whole-number line refunds on it, so that's the fair price). */
export function balancedTotal(dist: Record<string, number>): { line: number; over: number; under: number; push: number } {
  let best: { line: number; over: number; under: number; push: number } | null = null;
  for (let line = 4.5; line <= 7.5; line += 0.5) {
    const { over, under, push } = overUnder(dist, line);
    const live = 1 - push;
    if (live <= 0) continue;
    const cand = { line, over: over / live, under: under / live, push };
    if (!best || Math.abs(cand.over - 0.5) < Math.abs(best.over - 0.5)) best = cand;
  }
  return best ?? { line: 5.5, over: 0.5, under: 0.5, push: 0 };
}

/** P(a team covers a puck line) from the FINAL home-margin distribution. `line` is that team's own
 * handicap (-1.5 = must win by 2+, +1.5 = can lose by one). A game decided in overtime or a
 * shootout is always a one-goal margin on the official score, so -1.5 needs a regulation win by 2+. */
export function puckLineCover(margin: Record<string, number>, side: "home" | "away", line: number): number {
  let p = 0;
  for (const [k, v] of Object.entries(margin)) {
    const m = side === "home" ? Number(k) : -Number(k);
    if (m + line > 0) p += v;
  }
  return p;
}

/** P(a team wins / pushes a handicap bet) from the FINAL home-margin distribution. `line` is that team's own handicap
 * (-1.5, +1.5, 0, -1 ...); a whole-number line can push. */
export function marginCover(margin: Record<string, number>, side: "home" | "away", line: number): { win: number; push: number; lose: number } {
  let win = 0;
  let push = 0;
  let lose = 0;
  for (const [k, v] of Object.entries(margin)) {
    const m = (side === "home" ? Number(k) : -Number(k)) + line;
    if (m > 0) win += v;
    else if (m === 0) push += v;
    else lose += v;
  }
  return { win, push, lose };
}

export function americanToProb(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/** Fair (vig-removed) probability of side A from both sides' American prices. */
export function devig(a: number, b: number): number {
  const pa = americanToProb(a);
  const pb = americanToProb(b);
  return pa / (pa + pb);
}

export function fairMoneyline(m: NhlMarket | null): { home: number; away: number } | null {
  if (!m || m.ml_home === null || m.ml_away === null) return null;
  const home = devig(m.ml_home, m.ml_away);
  return { home, away: 1 - home };
}

export const pct = (p: number, digits = 1): string => `${(p * 100).toFixed(digits)}%`;

export function fmtOdds(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

/** Fair (no-vig) American price for a probability, rounded to a whole number; null when it's too close to 0 or 1 to mean anything. */
export function probToAmerican(p: number): number | null {
  if (!Number.isFinite(p) || p < 0.001 || p > 0.999) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

/** "-134" / "+287" for a probability, or "—". */
export function fairOdds(p: number): string {
  return fmtOdds(probToAmerican(p));
}

/** Model's most likely single final score and its probability (an official final never ties). */
export function mostLikelyScore(pred: NhlPrediction): { home: number; away: number; p: number } {
  let best = { home: 0, away: 0, p: -1 };
  pred.score_matrix.forEach((row, h) => row.forEach((p, a) => (p > best.p ? (best = { home: h, away: a, p }) : null)));
  return best;
}
