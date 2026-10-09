"""
The test that actually matters: does the model's win probability compare
with the market's? Joins backtest_predictions.csv.gz (walk-forward, no
lookahead except the xG cross-fit - see xg.py) with the de-vigged
consensus moneyline from odds.py and compares log loss on the SAME games.

How to read it:
  * market log loss < model log loss  -> the market knows things the model
    doesn't; expected, since closing lines are efficient and the baseline
    is a deliberately simple team-level model.
  * a blend (50/50 of model and market probabilities) beating the market
    alone is the interesting result - it means the model adds information
    the closing line didn't already contain.
  * the "edge bucket" table bets the model's side at the consensus price
    when it disagrees with the market by at least N points. Flat 1-unit
    stakes at de-vigged fair odds would be break-even in expectation, so
    this table measures ROI against FAIR prices, NOT against what a real
    book would pay (add the vig yourself: roughly -4.5% for a standard
    -110 market). Small samples - read the n column before the ROI column.

Usage:
    python -m nhl_model.compare_market
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .backtest import logloss
from .ingest import DATA_DIR
from .odds import ODDS_OUT, market_consensus


def run() -> None:
    preds = pd.read_csv(DATA_DIR / "backtest_predictions.csv.gz")
    odds = pd.read_csv(ODDS_OUT)
    mkt = market_consensus(odds)
    d = preds.merge(mkt[["game_id", "mkt_p_home", "n_books", "era"]], on="game_id", how="inner")
    print(f"{len(d)} of {len(preds)} backtest games have a market line\n")

    def line(label, x):
        y = x["home_win"].to_numpy()
        pm, pk = x["p_home"].to_numpy(), x["mkt_p_home"].to_numpy()
        blend = 0.5 * pm + 0.5 * pk
        print(f"{label:<26} n={len(x):<5} logloss  model {logloss(y, pm):.4f} | market {logloss(y, pk):.4f} | 50/50 blend {logloss(y, blend):.4f} | const {logloss(y, np.full(len(y), y.mean())):.4f}")

    line("ALL", d)
    for era, x in d.groupby("era"):
        line(f"era={era}", x)
    for s, x in d.groupby("season"):
        line(f"season {s}", x)

    print("\nBetting the model's side when it disagrees with the market (flat 1u at DE-VIGGED fair odds, no vig):")
    d["edge"] = d["p_home"] - d["mkt_p_home"]
    rows = []
    for thr in (0.0, 0.02, 0.04, 0.06):
        x = d[d["edge"].abs() >= thr]
        bet_home = x["edge"] > 0
        p_mkt = np.where(bet_home, x["mkt_p_home"], 1 - x["mkt_p_home"])
        won = np.where(bet_home, x["home_win"], 1 - x["home_win"])
        profit = np.where(won == 1, 1 / p_mkt - 1, -1.0)
        rows.append({"min_edge": thr, "n": len(x), "win_rate": won.mean(), "avg_fair_prob": p_mkt.mean(), "roi_vs_fair": profit.mean()})
    print(pd.DataFrame(rows).round(4).to_string(index=False))


if __name__ == "__main__":
    run()
