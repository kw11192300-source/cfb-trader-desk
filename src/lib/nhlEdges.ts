import { americanToProb, marginCover, overUnder, probToAmerican } from "./nhlModel";
import type { NhlPrediction } from "./types";

export type EdgeRow = {
  market: "Moneyline" | "Puck line" | "Total";
  side: string;
  /** The price on offer (American). */
  bookOdds: number;
  /** The win probability that price needs to break even - it includes the book's vig. */
  bookImplied: number;
  /** Our probability (a push, on a whole-number line, is taken out and refunded). */
  model: number;
  modelOdds: number | null;
  /** model - bookImplied, in probability points: how far our number is from what the actual price needs. */
  edgePts: number;
  /** Expected profit per 1 staked at that price, if the model is right. */
  ev: number;
};

const decimal = (american: number): number => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);

function row(market: EdgeRow["market"], side: string, bookOdds: number, model: number): EdgeRow {
  const implied = americanToProb(bookOdds);
  return { market, side, bookOdds, bookImplied: implied, model, modelOdds: probToAmerican(model), edgePts: (model - implied) * 100, ev: model * decimal(bookOdds) - 1 };
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

type Dists = Pick<NhlPrediction, "p_home" | "margin_dist" | "total_dist">;

/** Our probability for one side of one bet, with pushes refunded (so a whole-number line is priced without them). */
function modelProb(p: Dists, bet: { market: EdgeRow["market"]; side: "home" | "away" | "over" | "under"; line: number }): number {
  if (bet.market === "Moneyline") return bet.side === "home" ? p.p_home : 1 - p.p_home;
  if (bet.market === "Puck line") {
    const { win, push } = marginCover(p.margin_dist, bet.side === "home" ? "home" : "away", bet.line);
    return push < 1 ? win / (1 - push) : 0.5;
  }
  const { over, under } = overUnder(p.total_dist, bet.line);
  const live = over + under;
  if (live <= 0) return 0.5;
  return bet.side === "over" ? over / live : under / live;
}

/** A price you type in (from any book) priced against our simulation. `line` is that side's own handicap for a puck
 * line (-1.5 = must win by 2+), the total for a total, and ignored for a moneyline. */
export function customEdge(
  p: Dists,
  home: string,
  away: string,
  bet: { market: EdgeRow["market"]; side: "home" | "away" | "over" | "under"; line: number; odds: number },
): EdgeRow {
  const prob = modelProb(p, bet);
  const team = bet.side === "home" ? home : away;
  const label =
    bet.market === "Moneyline" ? team : bet.market === "Puck line" ? `${team} ${sign(bet.line)}` : `${bet.side === "over" ? "Over" : "Under"} ${bet.line}`;
  return row(bet.market, label, bet.odds, prob);
}

/** Every side of the moneyline, puck line and total that the book has posted, priced against our simulation. */
export function marketEdges(pred: NhlPrediction, home: string, away: string): EdgeRow[] {
  const m = pred.market;
  if (!m) return [];
  const out: EdgeRow[] = [];
  if (m.ml_home !== null && m.ml_away !== null) {
    out.push(
      customEdge(pred, home, away, { market: "Moneyline", side: "away", line: 0, odds: m.ml_away }),
      customEdge(pred, home, away, { market: "Moneyline", side: "home", line: 0, odds: m.ml_home }),
    );
  }
  if (m.spread_home_line !== null && m.spread_home_odds !== null && m.spread_away_odds !== null) {
    out.push(
      customEdge(pred, home, away, { market: "Puck line", side: "away", line: -m.spread_home_line, odds: m.spread_away_odds }),
      customEdge(pred, home, away, { market: "Puck line", side: "home", line: m.spread_home_line, odds: m.spread_home_odds }),
    );
  }
  if (m.total_line !== null && m.over_odds !== null && m.under_odds !== null) {
    out.push(
      customEdge(pred, home, away, { market: "Total", side: "over", line: m.total_line, odds: m.over_odds }),
      customEdge(pred, home, away, { market: "Total", side: "under", line: m.total_line, odds: m.under_odds }),
    );
  }
  return out;
}
