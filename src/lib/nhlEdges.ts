import { devig, overUnder, puckLineCover, probToAmerican } from "./nhlModel";
import type { NhlPrediction } from "./types";

export type EdgeRow = {
  market: "Moneyline" | "Puck line" | "Total";
  side: string;
  /** The book's posted American price. */
  bookOdds: number;
  /** The book's probability for this side with the vig removed. */
  bookNoVig: number;
  /** Our probability (a push, on a whole-number total, is taken out and refunded). */
  model: number;
  modelOdds: number | null;
  /** model - bookNoVig, in probability points. */
  edgePts: number;
  /** Expected profit per 1 staked at the book's posted price, if the model is right. */
  ev: number;
};

const decimal = (american: number): number => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);

function row(market: EdgeRow["market"], side: string, bookOdds: number, bookNoVig: number, model: number): EdgeRow {
  return { market, side, bookOdds, bookNoVig, model, modelOdds: probToAmerican(model), edgePts: (model - bookNoVig) * 100, ev: model * decimal(bookOdds) - 1 };
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** Every side of the moneyline, puck line and total that the book has posted, priced against our simulation. */
export function marketEdges(pred: NhlPrediction, home: string, away: string): EdgeRow[] {
  const m = pred.market;
  if (!m) return [];
  const out: EdgeRow[] = [];

  if (m.ml_home !== null && m.ml_away !== null) {
    const h = devig(m.ml_home, m.ml_away);
    out.push(row("Moneyline", away, m.ml_away, 1 - h, 1 - pred.p_home), row("Moneyline", home, m.ml_home, h, pred.p_home));
  }
  if (m.spread_home_line !== null && m.spread_home_odds !== null && m.spread_away_odds !== null) {
    const L = m.spread_home_line;
    const h = devig(m.spread_home_odds, m.spread_away_odds);
    out.push(
      row("Puck line", `${away} ${sign(-L)}`, m.spread_away_odds, 1 - h, puckLineCover(pred.margin_dist, "away", -L)),
      row("Puck line", `${home} ${sign(L)}`, m.spread_home_odds, h, puckLineCover(pred.margin_dist, "home", L)),
    );
  }
  if (m.total_line !== null && m.over_odds !== null && m.under_odds !== null) {
    const { over, under } = overUnder(pred.total_dist, m.total_line);
    const live = over + under;
    const o = devig(m.over_odds, m.under_odds);
    out.push(
      row("Total", `Over ${m.total_line}`, m.over_odds, o, live > 0 ? over / live : 0.5),
      row("Total", `Under ${m.total_line}`, m.under_odds, 1 - o, live > 0 ? under / live : 0.5),
    );
  }
  return out;
}
