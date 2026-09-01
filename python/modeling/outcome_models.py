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

FEATURE_COLUMNS = [
    "neutral_site",
    "conference_game",
    "elo_diff",
    "home_cum_off_ppa",
    "home_cum_def_ppa",
    "home_cum_off_success_rate",
    "home_cum_def_success_rate",
    "away_cum_off_ppa",
    "away_cum_def_ppa",
    "away_cum_off_success_rate",
    "away_cum_def_success_rate",
    "home_cum_off_plays",
    "away_cum_off_plays",
    "home_cum_points_scored",
    "home_cum_points_allowed",
    "away_cum_points_scored",
    "away_cum_points_allowed",
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
