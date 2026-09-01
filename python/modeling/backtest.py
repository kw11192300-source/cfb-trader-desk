"""
Walk-forward backtest across multiple season splits — the honest version
of the single train-2023/test-2024 check used throughout development.
Each split trains on every season strictly before the test season and
evaluates on that one season, rolling forward. A model that only looks
good on one particular holdout year isn't trustworthy; this is what
actually is.

Movement models are evaluated on 2022-2024 splits only (2021 is the first
season with usable spread_open coverage — see features.py's book-selection
docstring — so there's no earlier season to train movement on before it).
Outcome models use every season from 2016 onward (2015 is reserved as the
earliest training-only season so even the first split has real history).

Usage:
    python -m modeling.backtest
"""
from __future__ import annotations

import pandas as pd

from . import movement_model, outcome_models
from .features import build_training_dataset

OUTCOME_PARAMS = dict(max_iter=50, max_depth=3, min_samples_leaf=30, l2_regularization=1.0, learning_rate=0.05)
MOVEMENT_PARAMS = dict(max_iter=30, max_depth=2, min_samples_leaf=40, l2_regularization=3.0, learning_rate=0.04)

OUTCOME_TEST_SEASONS = list(range(2016, 2025))
MOVEMENT_TEST_SEASONS = list(range(2022, 2025))


def run_outcome_backtest(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for test_season in OUTCOME_TEST_SEASONS:
        train = df[df["season"] < test_season]
        test = df[df["season"] == test_season]
        if len(train) < 500 or len(test) == 0:
            continue

        margin_model = outcome_models.train_margin_model(train, **OUTCOME_PARAMS)
        total_model = outcome_models.train_total_model(train, **OUTCOME_PARAMS)
        win_model = outcome_models.train_win_prob_model(train, **OUTCOME_PARAMS)

        m = outcome_models.evaluate_regression(margin_model, test, "actual_margin")
        t = outcome_models.evaluate_regression(total_model, test, "actual_total")
        w = outcome_models.evaluate_classifier(win_model, test)

        rows.append(
            {
                "test_season": test_season,
                "n": m.get("n", 0),
                "margin_mae": m.get("mae"),
                "margin_r2": m.get("r2"),
                "total_mae": t.get("mae"),
                "total_r2": t.get("r2"),
                "win_acc": w.get("accuracy"),
                "win_naive_acc": w.get("naive_accuracy_always_home"),
                "win_brier": w.get("brier"),
            }
        )
    return pd.DataFrame(rows)


def run_movement_backtest(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for test_season in MOVEMENT_TEST_SEASONS:
        train = df[df["season"] < test_season].copy()
        test = df[df["season"] == test_season].copy()

        # Model-vs-market gap feature needs an outcome model trained on the
        # same train split (never peeking at the test season).
        margin_model = outcome_models.train_margin_model(train, **OUTCOME_PARAMS)
        for d in (train, test):
            d["predicted_margin"] = outcome_models.predict_margin(margin_model, d)
            d["model_market_gap"] = d["predicted_margin"] - (-d["market_spread_open"])

        s_model = movement_model.train_movement_model(train, "spread_move", **MOVEMENT_PARAMS)
        t_model = movement_model.train_movement_model(train, "total_move", **MOVEMENT_PARAMS)

        s = movement_model.evaluate(s_model, test, "spread_move")
        t = movement_model.evaluate(t_model, test, "total_move")

        rows.append(
            {
                "test_season": test_season,
                "spread_n": s.get("n", 0),
                "spread_mae": s.get("mae"),
                "spread_r2": s.get("r2"),
                "spread_dir_acc": s.get("direction_accuracy"),
                "total_n": t.get("n", 0),
                "total_mae": t.get("mae"),
                "total_r2": t.get("r2"),
                "total_dir_acc": t.get("direction_accuracy"),
            }
        )
    return pd.DataFrame(rows)


def run(seasons: list[int]) -> None:
    print(f"Building training dataset for {min(seasons)}-{max(seasons)}...")
    df = build_training_dataset(seasons)

    print("\n=== Outcome models (walk-forward, one row per test season) ===")
    outcome_report = run_outcome_backtest(df)
    print(outcome_report.round(3).to_string(index=False))
    print("\nAverages across all test seasons:")
    print(outcome_report.drop(columns=["test_season", "n"]).mean().round(3))

    print("\n=== Movement models (walk-forward, 2022-2024 only - see coverage note) ===")
    movement_report = run_movement_backtest(df)
    print(movement_report.round(3).to_string(index=False))
    print("\nAverages across all test seasons:")
    print(movement_report.drop(columns=["test_season", "spread_n", "total_n"]).mean().round(3))


if __name__ == "__main__":
    run(list(range(2015, 2025)))
