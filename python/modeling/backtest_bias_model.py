"""
Backtest for the untried bias-correction approach - `train_margin_bias_model`/
`predict_margin_with_bias_correction` in outcome_models.py, which has never
been evaluated before now. Instead of predicting the game outcome
independently (what predict_week1.py's model does, and what the raw
independent-model approach was already found to do ~53-56% ATS post-week-1
- see watchlist.py's docstring), this predicts the market's own ERROR
(actual_margin - market_implied_margin) and adds that back to the market's
line. Structurally anchored close to the market by default; a real edge
only shows up where there's a genuine, repeatable bias pattern in the
training data.

Explicitly scoped to POST-week-1 games (min_games >= 1 for both teams).
Week 1 already has its own validated, shipped model (predict_week1.py) -
the open question here is specifically whether this different framing
does any better than the already-known-mediocre raw approach in the
regime where that one already fell short.

Walk-forward, same methodology as backtest.py/backtest_week1.py: train on
every season strictly before the test season, evaluate out-of-sample,
roll forward.

Deliberately prints to stdout only - no Supabase writes, same as
backtest.py's own precedent for exploratory model evaluation. This is
purely a validation step; nothing gets served or shown in the UI unless
these numbers actually earn it.

Usage:
    python -m modeling.backtest_bias_model
"""
from __future__ import annotations

import datetime

import numpy as np
import pandas as pd

from .features import build_training_dataset
from .outcome_models import predict_margin_with_bias_correction, train_margin_bias_model

FIRST_TEST_SEASON = 2016
EDGE_BUCKETS = [(0, 3), (3, 6), (6, 9), (9, 100)]


def _grade(df: pd.DataFrame, last_complete_season: int, spread_col: str = "market_spread") -> pd.DataFrame:
    """One row per post-week-1 game across every walk-forward test season,
    with the bias-corrected out-of-sample prediction, edge, and whether the
    pick covered.

    spread_col picks which market number grading is computed against -
    "market_spread" (closing, default) or "market_spread_open" (the
    opener). Note: the model itself is always trained against CLOSING-line
    bias (predict_margin_with_bias_correction reads market_spread
    internally) - the opening-line check below re-anchors the same
    closing-trained model's predicted bias onto the opening number for
    grading, it does not retrain a separate opening-anchored model. Same
    caveat backtest_week1.py already flags for its own opening-line
    check: real open-line coverage only exists 2021+, and partially even
    then - smaller, noisier sample, not a like-for-like replacement of
    the closing-line number."""
    all_rows = []
    for test_season in range(FIRST_TEST_SEASON, last_complete_season + 1):
        train = df[df["season"] < test_season]
        test = df[df["season"] == test_season].dropna(subset=[spread_col, "actual_margin", "market_spread"]).copy()
        if train.empty or test.empty:
            continue
        model = train_margin_bias_model(train)
        pred_input = test if spread_col == "market_spread" else test.assign(market_spread=test[spread_col])
        test["pred"] = predict_margin_with_bias_correction(model, pred_input).to_numpy()
        all_rows.append(test)
    full = pd.concat(all_rows, ignore_index=True)

    full["min_games"] = full[["home_games_played", "away_games_played"]].min(axis=1)
    market_implied = -full[spread_col]
    full["edge"] = full["pred"] - market_implied
    full["pick_home"] = full["edge"] > 0
    home_covers = full["actual_margin"] + full[spread_col] > 0
    away_covers = full["actual_margin"] + full[spread_col] < 0
    push = full["actual_margin"] + full[spread_col] == 0
    full["correct"] = np.where(full["pick_home"], home_covers, away_covers)
    full["matchup_type"] = np.where(
        full["home_is_fbs"] & full["away_is_fbs"], "fbs_vs_fbs", np.where(full["home_is_fbs"] != full["away_is_fbs"], "buy_game", "fcs_vs_fcs")
    )
    # Post-week-1 only - both teams have real in-season evidence. This is
    # the whole point: week 1 already has its own validated model.
    return full[(full["min_games"] >= 1) & (~push)].copy()


def _print_breakdown(df: pd.DataFrame, group_col: str, label: str) -> None:
    print(f"\n--- {label} ---")
    if len(df) == 0:
        print("  (no rows)")
        return
    g = df.groupby(group_col, observed=True)["correct"].agg(["mean", "count"]).rename(columns={"mean": "win_rate", "count": "n"})
    print(g.round(4).to_string())


def run() -> None:
    last_complete_season = datetime.date.today().year - 1  # this year's season isn't complete yet
    print(f"Building training dataset ({2015}-{last_complete_season})...")
    df = build_training_dataset(list(range(2015, last_complete_season + 1)))

    print("Grading every post-week-1 game, walk-forward (closing line)...")
    graded = _grade(df, last_complete_season)
    fbs = graded[graded["matchup_type"] == "fbs_vs_fbs"].copy()
    fbs["season"] = fbs["season"].astype(int)

    print("\n=== Headline: FBS vs FBS, post-week-1, closing line ===")
    print(f"n={len(fbs)}  ATS win rate={fbs['correct'].mean():.4f}  (break-even @ -110 = 0.5238)")
    print("For context, already on record this project: raw independent-model approach ~0.53-0.56 post-week-1; Watchlist market-confirmation split 0.644 (confirmed) vs 0.414 (unconfirmed), n=74.")

    _print_breakdown(fbs, "season", "By season (consistency check - one good year isn't enough)")

    fbs["edge_bucket"] = pd.cut(
        fbs["edge"].abs(),
        bins=[b[0] for b in EDGE_BUCKETS] + [float("inf")],
        right=False,
        labels=[f"{lo}-{hi}" if hi < 100 else f"{lo}+" for lo, hi in EDGE_BUCKETS],
    )
    _print_breakdown(fbs, "edge_bucket", "By |edge| bucket (does a bigger edge actually mean a better hit rate?)")

    fbs["picked_favorite"] = np.where(fbs["pick_home"], fbs["market_spread"] < 0, fbs["market_spread"] > 0)
    _print_breakdown(fbs, "picked_favorite", "Bias check: favorite vs underdog")
    _print_breakdown(fbs, "pick_home", "Bias check: home vs away")

    _print_breakdown(graded, "matchup_type", "By matchup type (all games, not just the FBS-vs-FBS pool above)")

    print("\nRe-grading against opening lines (edge_type check - see caveat in _grade's docstring)...")
    graded_open = _grade(df, last_complete_season, spread_col="market_spread_open")
    fbs_open = graded_open[graded_open["matchup_type"] == "fbs_vs_fbs"]
    if len(fbs_open) > 0:
        open_seasons = sorted(int(s) for s in fbs_open["season"].unique())
        print(f"n={len(fbs_open)}  ATS win rate={fbs_open['correct'].mean():.4f}  (closing-line comparable n={len(fbs)}; seasons with real open-line coverage: {open_seasons})")
    else:
        print("  no opening-line coverage in this season range.")


if __name__ == "__main__":
    run()
