"""
Predicts game outcomes (margin, total, win probability) from team-strength
features only — deliberately NOT fed the market's own line (see the
modeling plan: "don't overweight the market"). The model's job is to form
an independent view; comparing that view to the market happens after the
fact (edge = predicted - market), not baked in as an input.

Same feature set as movement_model.py minus the market_*_open columns.
"""
from __future__ import annotations

import joblib
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import accuracy_score, brier_score_loss, mean_absolute_error, r2_score

from .features import PPA_STAT_COLS

FEATURE_COLUMNS = [
    "neutral_site",
    "conference_game",
    "home_power_conf",
    "away_power_conf",
    "home_is_fbs",
    "away_is_fbs",
    "is_cross_division",
    "elo_diff",
    "home_prior_srs",
    "away_prior_srs",
    *[f"home_cum_{c}" for c in PPA_STAT_COLS],
    *[f"away_cum_{c}" for c in PPA_STAT_COLS],
    "home_cum_points_scored",
    "home_cum_points_allowed",
    "away_cum_points_scored",
    "away_cum_points_allowed",
    # How much real IN-SEASON evidence backs this game's ratings, as
    # opposed to still mostly reflecting a preseason projection/prior -
    # lets the model learn to trust its own inputs less early in a season
    # (see preseason_projection.py's confidence discussion).
    "home_games_played",
    "away_games_played",
    "home_cum_turnover_margin",
    "away_cum_turnover_margin",
    "home_cum_possession_seconds",
    "away_cum_possession_seconds",
    "home_cum_third_down_pct",
    "away_cum_third_down_pct",
    "home_cum_penalty_yards",
    "away_cum_penalty_yards",
    "home_prior_sp_plus",
    "away_prior_sp_plus",
    "home_talent",
    "away_talent",
    "home_returning_ppa_pct",
    "away_returning_ppa_pct",
    "home_net_transfer_stars",
    "away_net_transfer_stars",
    "home_market_rating",
    "away_market_rating",
    "home_results_rating",
    "away_results_rating",
    "home_scoring_off",
    "home_scoring_def",
    "away_scoring_off",
    "away_scoring_def",
    "home_efficiency_off",
    "home_efficiency_def",
    "away_efficiency_off",
    "away_efficiency_def",
]


def prepare_xy(df: pd.DataFrame, target_col: str) -> tuple[pd.DataFrame, pd.Series]:
    valid = df.dropna(subset=[target_col])
    X = valid[FEATURE_COLUMNS].astype(float)
    y = valid[target_col]
    return X, y


def train_margin_model(df: pd.DataFrame, **params) -> HistGradientBoostingRegressor:
    X, y = prepare_xy(df, "actual_margin")
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y.astype(float))
    return model


def train_margin_bias_model(df: pd.DataFrame, **params) -> HistGradientBoostingRegressor:
    """Predicts the market's ERROR (actual_margin - market's own implied
    margin) instead of the outcome independently. Final prediction =
    market_implied_margin + predicted_bias. Structurally keeps predictions
    close to the market by default (the training target is usually small -
    the market is right most of the time), with a genuine edge only
    showing up where the training data has a real, repeatable bias
    pattern - directly targets "predictions should track the market
    closely, with edges as small deviations" rather than an independent
    model whose disagreement with market is somewhat arbitrary in size.
    """
    valid = df.dropna(subset=["actual_margin", "market_spread"])
    market_implied_margin = -valid["market_spread"].astype(float)
    y = valid["actual_margin"].astype(float) - market_implied_margin
    X = valid[FEATURE_COLUMNS].astype(float)
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y)
    return model


def predict_margin_with_bias_correction(model: HistGradientBoostingRegressor, df: pd.DataFrame) -> pd.Series:
    X = df[FEATURE_COLUMNS].astype(float)
    bias = model.predict(X)
    market_implied_margin = -df["market_spread"].astype(float)
    return pd.Series(market_implied_margin.to_numpy() + bias, index=df.index)


def train_total_model(df: pd.DataFrame, **params) -> HistGradientBoostingRegressor:
    X, y = prepare_xy(df, "actual_total")
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y.astype(float))
    return model


def train_win_prob_model(df: pd.DataFrame, **params) -> HistGradientBoostingClassifier:
    X, y = prepare_xy(df, "home_win")
    model = HistGradientBoostingClassifier(random_state=42, **params)
    model.fit(X, y.astype(int))
    return model


def evaluate_regression(model, df: pd.DataFrame, target_col: str) -> dict:
    X, y = prepare_xy(df, target_col)
    if len(y) == 0:
        return {"n": 0}
    pred = model.predict(X)
    naive = [y.mean()] * len(y)  # "always predict the average" baseline
    return {
        "n": len(y),
        "mae": mean_absolute_error(y, pred),
        "r2": r2_score(y, pred),
        "mae_vs_naive_mean": mean_absolute_error(y, naive),
    }


def evaluate_classifier(model, df: pd.DataFrame, target_col: str = "home_win") -> dict:
    X, y = prepare_xy(df, target_col)
    if len(y) == 0:
        return {"n": 0}
    proba = model.predict_proba(X)[:, 1]
    pred = proba > 0.5
    return {
        "n": len(y),
        "accuracy": accuracy_score(y, pred),
        "brier": brier_score_loss(y, proba),  # lower is better; 0.25 = always guessing 50/50
        "naive_accuracy_always_home": y.mean(),  # baseline: home teams win more often than not
    }


def predict_margin(model, df: pd.DataFrame) -> pd.Series:
    X = df[FEATURE_COLUMNS].astype(float)
    return pd.Series(model.predict(X), index=df.index)


def save_model(model, path: str) -> None:
    joblib.dump(model, path)


def load_model(path: str):
    return joblib.load(path)
