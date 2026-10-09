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

/** Model's most likely single final score and its probability (an official final never ties). */
export function mostLikelyScore(pred: NhlPrediction): { home: number; away: number; p: number } {
  let best = { home: 0, away: 0, p: -1 };
  pred.score_matrix.forEach((row, h) => row.forEach((p, a) => (p > best.p ? (best = { home: h, away: a, p }) : null)));
  return best;
}
