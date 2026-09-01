"""
Predicts how much (and which direction) a line will move from open to
close — the top-priority model per the project brief: signal which games
are worth getting ahead of before the market catches up.

One regressor per market (spread, total), predicting the SIGNED move
directly (spread_move = close - open) rather than separate
magnitude/direction models — simpler, and magnitude (abs) and direction
(sign) both fall out of one prediction. Trained on the full historical
open-vs-close data already in betting_lines (no need to wait on
line_snapshots accumulating in real time — see features.py).

Uses HistGradientBoostingRegressor, which handles NaN features natively
(a real advantage here: several features, like FCS opponents' Elo/SP+/
market rating, are legitimately missing rather than imputable) — no
manual imputation needed.
"""
from __future__ import annotations

import joblib
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

from .features import PPA_STAT_COLS

FEATURE_COLUMNS = [
    "neutral_site",
    "conference_game",
    "home_power_conf",
    "away_power_conf",
    "elo_diff",
    *[f"home_cum_{c}" for c in PPA_STAT_COLS],
    *[f"away_cum_{c}" for c in PPA_STAT_COLS],
    "home_cum_points_scored",
    "home_cum_points_allowed",
    "away_cum_points_scored",
    "away_cum_points_allowed",
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
    # The opening number itself is a legitimate predictor of how much it'll
    # move (e.g. round-number/large spreads move more) - this is NOT the
    # "don't overweight the market" concern from the outcome models (which
    # was about not anchoring OUTCOME predictions to today's line); here the
    # open IS the input the live product actually has the moment it's worth
    # predicting movement at all.
    "market_spread_open",
    "market_total_open",
    "day_of_week",
    "is_home_favorite",
]

# Added on top of FEATURE_COLUMNS when present (requires a trained outcome
# model's predictions merged in first — see train_movement.py/notebooks,
# not produced by features.py itself). Not required: prepare_xy only uses
# columns that are actually present in the given df, so movement models can
# still be trained/evaluated without it.
GAP_FEATURE = "model_market_gap"


def _active_feature_columns(df: pd.DataFrame) -> list[str]:
    cols = list(FEATURE_COLUMNS)
    if GAP_FEATURE in df.columns:
        cols.append(GAP_FEATURE)
    return cols


def prepare_xy(df: pd.DataFrame, target_col: str) -> tuple[pd.DataFrame, pd.Series]:
    valid = df.dropna(subset=[target_col])
    X = valid[_active_feature_columns(df)].astype(float)
    y = valid[target_col].astype(float)
    return X, y


def train_movement_model(df: pd.DataFrame, target_col: str, **params) -> HistGradientBoostingRegressor:
    X, y = prepare_xy(df, target_col)
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y)
    return model


def evaluate(model: HistGradientBoostingRegressor, df: pd.DataFrame, target_col: str) -> dict:
    X, y = prepare_xy(df, target_col)
    if len(y) == 0:
        return {"n": 0}
    pred = model.predict(X)
    return {
        "n": len(y),
        "mae": mean_absolute_error(y, pred),
        "r2": r2_score(y, pred),
        "mae_vs_naive_zero": mean_absolute_error(y, [0] * len(y)),  # "predict no movement at all" baseline
        "direction_accuracy": ((pred > 0) == (y > 0)).mean(),
    }


def save_model(model: HistGradientBoostingRegressor, path: str) -> None:
    joblib.dump(model, path)


def load_model(path: str) -> HistGradientBoostingRegressor:
    return joblib.load(path)
