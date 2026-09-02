"""
Walk-forward backtest for predict_week1.py's strategy - stores results in
model_backtests for the site's own Backtest tab, so this doesn't live only
in chat transcripts. Recomputes from scratch each run (train margin model
fresh per test season, same as predict_week1.py itself) rather than
reusing any cached artifact, so it stays honest as more seasons complete.

Three breakdowns stored, all under MODEL_VERSION:
  - season_win_rate: top-15-by-edge, FBS-vs-FBS, week-1-of-season picks,
    one row per test season 2016-2025 - the headline chart.
  - matchup_type: same top-15-by-edge selection, broken out by
    fbs_vs_fbs / buy_game / fcs_vs_fcs - why this is FBS-only (the other
    two showed no edge when isolated, see predict_week1.py's docstring).
  - bias_check: win rate split by picked-favorite vs picked-underdog and
    picked-home vs picked-away, on the FBS-vs-FBS top-15 pool - checks
    this isn't just a disguised "always take the dog" trick.

Usage:
    python -m modeling.backtest_week1
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from cfbd_ingest.supabase_client import get_client

from .features import build_training_dataset
from .outcome_models import FEATURE_COLUMNS
from .predict_week1 import MODEL_VERSION, TOP_N

FIRST_TEST_SEASON = 2016


def _train_predict(train_df: pd.DataFrame, test_df: pd.DataFrame) -> np.ndarray:
    valid_train = train_df.dropna(subset=["actual_margin"])
    X_train = valid_train[FEATURE_COLUMNS].astype(float)
    y_train = valid_train["actual_margin"].astype(float)
    model = HistGradientBoostingRegressor(random_state=42)
    model.fit(X_train, y_train)
    return model.predict(test_df[FEATURE_COLUMNS].astype(float))


def _graded_week1(df: pd.DataFrame, last_complete_season: int) -> pd.DataFrame:
    """One row per week-1 game across every walk-forward test season, with
    the model's out-of-sample prediction, edge, and whether the pick
    covered - the shared basis for all three breakdowns below."""
    all_rows = []
    for test_season in range(FIRST_TEST_SEASON, last_complete_season + 1):
        train = df[df["season"] < test_season]
        test = df[df["season"] == test_season].dropna(subset=["market_spread", "actual_margin"]).copy()
        if train.empty or test.empty:
            continue
        test["pred"] = _train_predict(train, test)
        all_rows.append(test)
    full = pd.concat(all_rows, ignore_index=True)

    full["min_games"] = full[["home_games_played", "away_games_played"]].min(axis=1)
    market_implied = -full["market_spread"]
    full["edge"] = full["pred"] - market_implied
    full["pick_home"] = full["edge"] > 0
    home_covers = full["actual_margin"] + full["market_spread"] > 0
    away_covers = full["actual_margin"] + full["market_spread"] < 0
    push = full["actual_margin"] + full["market_spread"] == 0
    full["correct"] = np.where(full["pick_home"], home_covers, away_covers)
    full["matchup_type"] = np.where(
        full["home_is_fbs"] & full["away_is_fbs"], "fbs_vs_fbs", np.where(full["home_is_fbs"] != full["away_is_fbs"], "buy_game", "fcs_vs_fcs")
    )
    return full[(full["min_games"] == 0) & (~push)].copy()


def run() -> None:
    print("Building training dataset (2015 through last completed season)...")
    seasons = list(range(2015, FIRST_TEST_SEASON))  # placeholder, replaced below once we know the range
    import datetime

    last_complete_season = datetime.date.today().year - 1  # this year's season isn't complete yet
    df = build_training_dataset(list(range(2015, last_complete_season + 1)))

    print("Grading every week-1 game, walk-forward...")
    wk1 = _graded_week1(df, last_complete_season)
    fbs = wk1[wk1["matchup_type"] == "fbs_vs_fbs"]

    records = []

    # --- season_win_rate: top-N by edge, FBS-vs-FBS, per season ---
    for i, season in enumerate(sorted(fbs["season"].unique())):
        top = fbs[fbs["season"] == season].reindex(fbs[fbs["season"] == season]["edge"].abs().sort_values(ascending=False).index).head(TOP_N)
        if len(top) == 0:
            continue
        records.append(
            {"group_key": "season_win_rate", "label": str(int(season)), "n": len(top), "win_rate": float(top["correct"].mean()), "sort_order": int(season)}
        )

    # --- matchup_type: top-N-by-edge-per-season, for each matchup type ---
    for order, mtype in enumerate(["fbs_vs_fbs", "buy_game", "fcs_vs_fcs"]):
        pool = wk1[wk1["matchup_type"] == mtype]
        tops = []
        for season, g in pool.groupby("season"):
            tops.append(g.reindex(g["edge"].abs().sort_values(ascending=False).index).head(TOP_N))
        if not tops:
            continue
        top_all = pd.concat(tops)
        records.append({"group_key": "matchup_type", "label": mtype, "n": len(top_all), "win_rate": float(top_all["correct"].mean()), "sort_order": order})

    # --- bias_check: on the FBS-vs-FBS top-N pool ---
    fbs_tops = []
    for season, g in fbs.groupby("season"):
        fbs_tops.append(g.reindex(g["edge"].abs().sort_values(ascending=False).index).head(TOP_N))
    fbs_top = pd.concat(fbs_tops)
    fbs_top["picked_is_favorite"] = np.where(fbs_top["pick_home"], fbs_top["market_spread"] < 0, fbs_top["market_spread"] > 0)

    for order, (label, mask) in enumerate(
        [
            ("picked_favorite", fbs_top["picked_is_favorite"]),
            ("picked_underdog", ~fbs_top["picked_is_favorite"]),
            ("picked_home", fbs_top["pick_home"]),
            ("picked_away", ~fbs_top["pick_home"]),
        ]
    ):
        sub = fbs_top[mask]
        if len(sub) == 0:
            continue
        records.append({"group_key": "bias_check", "label": label, "n": len(sub), "win_rate": float(sub["correct"].mean()), "sort_order": order})

    client = get_client()
    client.table("model_backtests").delete().eq("model_version", MODEL_VERSION).execute()
    for r in records:
        r["model_version"] = MODEL_VERSION
    for i in range(0, len(records), 500):
        client.table("model_backtests").insert(records[i : i + 500]).execute()
    print(f"Wrote {len(records)} backtest rows (model_version={MODEL_VERSION}).")


if __name__ == "__main__":
    run()
