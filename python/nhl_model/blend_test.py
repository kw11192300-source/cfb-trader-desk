"""
Is the model worth blending with the market?

For every game with a real closing line, three win probabilities for the home team: the simulator's (pre-game, no look
at the result), the market's (de-vigged close, averaged across books), and a logistic blend of the two:

    logit(p) = a + w_model * logit(model) + w_market * logit(market)

Weights are fitted on the OTHER seasons (leave-one-season-out), so every game is scored by a blend that never saw its
own season. Log loss is lower-is-better; the market alone is the bar to beat.

    python -m nhl_model.blend_test
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from .ingest import DATA_DIR
from .odds import ODDS_OUT, market_consensus

warnings.filterwarnings("ignore")


def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main() -> None:
    sp = pd.read_csv(DATA_DIR / "sim_predictions.csv.gz", usecols=["game_id", "season", "p_home", "home_win"])
    mk = market_consensus(pd.read_csv(ODDS_OUT))
    d = sp.merge(mk[["game_id", "mkt_p_home", "era", "n_books"]], on="game_id")
    d = d[d["era"] == "close"].dropna(subset=["home_win"]).copy()
    d["season"] = d["season"].astype(int) // 10000 if d["season"].max() > 9999 else d["season"].astype(int)
    print(f"{len(d)} games with a true closing line; seasons: {d.groupby('season').size().to_dict()}")

    d["x_model"], d["x_mkt"] = logit(d["p_home"].to_numpy()), logit(d["mkt_p_home"].to_numpy())
    d["p_blend"] = np.nan
    d["w_model"], d["w_mkt"] = np.nan, np.nan
    for season in sorted(d["season"].unique()):
        tr, te = d[d["season"] != season], d[d["season"] == season]
        m = LogisticRegression(C=1e6, max_iter=500).fit(tr[["x_model", "x_mkt"]], tr["home_win"])
        d.loc[te.index, "p_blend"] = m.predict_proba(te[["x_model", "x_mkt"]])[:, 1]
        d.loc[te.index, "w_model"], d.loc[te.index, "w_mkt"] = m.coef_[0][0], m.coef_[0][1]

    print(f"\n{'season':<8}{'games':>6}{'model':>9}{'market':>9}{'blend':>9}{'blend - market':>16}{'w_model':>9}{'w_market':>9}")
    for season, g in d.groupby("season"):
        y = g["home_win"].to_numpy()
        lm, lk, lb = ll(y, g["p_home"]), ll(y, g["mkt_p_home"]), ll(y, g["p_blend"])
        print(f"{season:<8}{len(g):>6}{lm:>9.4f}{lk:>9.4f}{lb:>9.4f}{lb - lk:>+16.4f}{g['w_model'].iloc[0]:>9.2f}{g['w_mkt'].iloc[0]:>9.2f}")
    y = d["home_win"].to_numpy()
    lm, lk, lb = ll(y, d["p_home"]), ll(y, d["mkt_p_home"]), ll(y, d["p_blend"])
    print(f"{'ALL':<8}{len(d):>6}{lm:>9.4f}{lk:>9.4f}{lb:>9.4f}{lb - lk:>+16.4f}")

    # fixed-weight blends, for an intuition of how much model to let in
    print("\nmarket-anchored blends (weight on the model's logit, remainder on the market's), all seasons:")
    for w in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0):
        p = 1 / (1 + np.exp(-(w * d["x_model"] + (1 - w) * d["x_mkt"])))
        print(f"  w_model = {w:.2f}: log loss {ll(y, p):.4f}")

    # where the model and market disagree most, who is closer?
    d["gap"] = (d["p_home"] - d["mkt_p_home"]).abs()
    print("\nwhen the model and market disagree by 8+ points:")
    big = d[d["gap"] >= 0.08]
    print(f"  {len(big)} games - log loss model {ll(big['home_win'], big['p_home']):.4f}  market {ll(big['home_win'], big['mkt_p_home']):.4f}  blend {ll(big['home_win'], big['p_blend']):.4f}")


if __name__ == "__main__":
    main()
