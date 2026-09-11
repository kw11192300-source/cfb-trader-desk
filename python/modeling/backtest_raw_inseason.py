"""
Backtest for the RAW independent-model approach (predict_week1.py's own
model class, `train_margin_model`/`predict_margin`) applied post-week-1 -
re-verifying, against the CURRENT feature set, a number this project has
so far only cited from an older comment in watchlist.py's docstring
(~53-56% ATS). Same shape as backtest_bias_model.py (which found the
bias-correction reframing actually did WORSE, 51.75%) so the two numbers
are directly comparable, computed the same way, same session.

Unlike the bias-correction model, `predict_margin` never reads
market_spread to form its prediction - the prediction is fixed once
trained; only the "which market number do we grade against" question
changes between the closing-line and opening-line checks below.

Explicitly scoped to POST-week-1 games (min_games >= 1 for both teams) -
week 1 already has its own validated, shipped model (predict_week1.py).

Deliberately prints to stdout only - no Supabase writes, same as
backtest.py/backtest_bias_model.py's precedent. This number is what
justifies (or doesn't) the disclaimer text on any week-2+ UI - it has to
be real, not assumed.

Usage:
    python -m modeling.backtest_raw_inseason
"""
from __future__ import annotations

import datetime

import numpy as np
import pandas as pd

from .features import build_training_dataset
from .outcome_models import predict_margin, train_margin_model

FIRST_TEST_SEASON = 2016
EDGE_BUCKETS = [(0, 3), (3, 6), (6, 9), (9, 100)]


def _grade(df: pd.DataFrame, last_complete_season: int, spread_col: str = "market_spread") -> pd.DataFrame:
    """One row per post-week-1 game across every walk-forward test season,
    with the independent out-of-sample prediction, edge, and whether the
    pick covered. spread_col picks which market number grading is computed
    against - the prediction itself is identical either way (see module
    docstring)."""
    all_rows = []
    for test_season in range(FIRST_TEST_SEASON, last_complete_season + 1):
        train = df[df["season"] < test_season]
        test = df[df["season"] == test_season].dropna(subset=[spread_col, "actual_margin"]).copy()
        if train.empty or test.empty:
            continue
        model = train_margin_model(train)
        test["pred"] = predict_margin(model, test).to_numpy()
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
    return full[(full["min_games"] >= 1) & (~push)].copy()


def _print_breakdown(df: pd.DataFrame, group_col: str, label: str) -> None:
    print(f"\n--- {label} ---")
    if len(df) == 0:
        print("  (no rows)")
        return
    g = df.groupby(group_col, observed=True)["correct"].agg(["mean", "count"]).rename(columns={"mean": "win_rate", "count": "n"})
    print(g.round(4).to_string())


def run() -> None:
    last_complete_season = datetime.date.today().year - 1
    print(f"Building training dataset ({2015}-{last_complete_season})...")
    df = build_training_dataset(list(range(2015, last_complete_season + 1)))

    print("Grading every post-week-1 game, walk-forward (closing line)...")
    graded = _grade(df, last_complete_season)
    fbs = graded[graded["matchup_type"] == "fbs_vs_fbs"].copy()
    fbs["season"] = fbs["season"].astype(int)

    print("\n=== Headline: FBS vs FBS, post-week-1, closing line (RAW independent model) ===")
    print(f"n={len(fbs)}  ATS win rate={fbs['correct'].mean():.4f}  (break-even @ -110 = 0.5238)")
    print("For context, this session: bias-correction reframing came back 0.5175 on the identical scope/season range. Watchlist market-confirmation split 0.644 (confirmed) vs 0.414 (unconfirmed), n=74.")

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

    print("\nRe-grading against opening lines (edge_type check)...")
    graded_open = _grade(df, last_complete_season, spread_col="market_spread_open")
    fbs_open = graded_open[graded_open["matchup_type"] == "fbs_vs_fbs"]
    if len(fbs_open) > 0:
        open_seasons = sorted(int(s) for s in fbs_open["season"].unique())
        print(f"n={len(fbs_open)}  ATS win rate={fbs_open['correct'].mean():.4f}  (closing-line comparable n={len(fbs)}; seasons with real open-line coverage: {open_seasons})")
    else:
        print("  no opening-line coverage in this season range.")


if __name__ == "__main__":
    run()
