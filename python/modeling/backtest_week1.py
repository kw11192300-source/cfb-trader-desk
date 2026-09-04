"""
Walk-forward backtest for predict_week1.py's strategy - stores results in
model_backtests (aggregate breakdowns) and model_backtest_games (every
individual graded game, for the site's browsable/filterable game list) so
none of this lives only in chat transcripts. Recomputes from scratch each
run (train margin model fresh per test season, same as predict_week1.py
itself) rather than reusing any cached artifact, so it stays honest as
more seasons complete.

Aggregate breakdowns in model_backtests, all under MODEL_VERSION:
  - season_win_rate: top-15-by-edge, FBS-vs-FBS, week-1-of-season picks,
    one row per test season 2016-2025 - the headline chart.
  - matchup_type: same top-15-by-edge selection, broken out by
    fbs_vs_fbs / buy_game / fcs_vs_fcs - why this is FBS-only (the other
    two showed no edge when isolated, see predict_week1.py's docstring).
  - bias_check: win rate split by picked-favorite vs picked-underdog and
    picked-home vs picked-away, on the FBS-vs-FBS top-15 pool - checks
    this isn't just a disguised "always take the dog" trick.
  - edge_bucket: FBS-vs-FBS top-15 pool split by edge size (how much the
    model and market disagreed) - lets predict_week1.py ground each live
    pick's rationale in "edges this size have hit X% historically"
    instead of citing one blanket number for every pick.
  - edge_type: same top-15-by-edge selection, but computed two ways -
    "closing" (market_spread, what every other breakdown here uses -
    effectively the closing/last-captured line for a historical game) vs.
    "opening" (market_spread_open, what a bet placed early in the week
    actually sees). Answers "is this still validated if I bet early?"
    directly instead of leaving it to guesswork - see the note on that
    row for the real caveat (CFBD only has real open-line data 2021+, and
    only ~40% of games even then, so this is a smaller/noisier sample
    than the headline number, not a like-for-like replacement of it).

model_backtest_games: every week-1 game graded across 2016-2025 (all
matchup types, not just the FBS-vs-FBS top-15 pool) with is_selected
flagging whether it was in that season's top-15-by-edge pool for its own
matchup type - the site's filter tool can reproduce the exact strategy
(matchup_type=fbs_vs_fbs, is_selected=true) or explore beyond it.

Usage:
    python -m modeling.backtest_week1
"""
from __future__ import annotations

import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from cfbd_ingest.supabase_client import fetch_all, get_client

from .features import _fetch_seasons, build_training_dataset
from .outcome_models import FEATURE_COLUMNS
from .predict_week1 import MODEL_VERSION, TOP_N, _build_rationale, _pick_spread_view

FIRST_TEST_SEASON = 2016
EDGE_BUCKETS = [(6, 9), (9, 12), (12, 15), (15, 100)]


def _train_predict(train_df: pd.DataFrame, test_df: pd.DataFrame) -> np.ndarray:
    valid_train = train_df.dropna(subset=["actual_margin"])
    X_train = valid_train[FEATURE_COLUMNS].astype(float)
    y_train = valid_train["actual_margin"].astype(float)
    model = HistGradientBoostingRegressor(random_state=42)
    model.fit(X_train, y_train)
    return model.predict(test_df[FEATURE_COLUMNS].astype(float))


def _graded_week1(df: pd.DataFrame, last_complete_season: int, spread_col: str = "market_spread") -> pd.DataFrame:
    """One row per week-1 game across every walk-forward test season, with
    the model's out-of-sample prediction, edge, and whether the pick
    covered - the shared basis for every breakdown below.

    spread_col picks which market number edge/grading is computed against
    - "market_spread" (default, effectively the closing line for a
    historical game) or "market_spread_open" (the opener - a season with
    no real open-line data on file drops out entirely via the dropna
    below, exactly as intended)."""
    all_rows = []
    for test_season in range(FIRST_TEST_SEASON, last_complete_season + 1):
        train = df[df["season"] < test_season]
        test = df[df["season"] == test_season].dropna(subset=[spread_col, "actual_margin"]).copy()
        if train.empty or test.empty:
            continue
        test["pred"] = _train_predict(train, test)
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
    return full[(full["min_games"] == 0) & (~push)].copy()


def _top_n_per_season(pool: pd.DataFrame, n: int) -> pd.DataFrame:
    tops = [g.reindex(g["edge"].abs().sort_values(ascending=False).index).head(n) for _, g in pool.groupby("season")]
    return pd.concat(tops) if tops else pool.iloc[0:0]


def run() -> None:
    print("Building training dataset (2015 through last completed season)...")
    last_complete_season = datetime.date.today().year - 1  # this year's season isn't complete yet
    df = build_training_dataset(list(range(2015, last_complete_season + 1)))

    print("Grading every week-1 game, walk-forward...")
    wk1 = _graded_week1(df, last_complete_season)

    # is_selected: within its OWN matchup type's top-15-by-edge pool that
    # season - the FBS-vs-FBS subset of this is "the strategy"; the other
    # two types get the same flag for the matchup_type comparison.
    wk1["is_selected"] = False
    for mtype in ["fbs_vs_fbs", "buy_game", "fcs_vs_fcs"]:
        pool = wk1[wk1["matchup_type"] == mtype]
        selected_idx = _top_n_per_season(pool, TOP_N).index
        wk1.loc[selected_idx, "is_selected"] = True

    fbs_top = wk1[(wk1["matchup_type"] == "fbs_vs_fbs") & wk1["is_selected"]]

    records = []

    # --- season_win_rate ---
    for season in sorted(fbs_top["season"].unique()):
        top = fbs_top[fbs_top["season"] == season]
        records.append(
            {"group_key": "season_win_rate", "label": str(int(season)), "n": len(top), "win_rate": float(top["correct"].mean()), "sort_order": int(season)}
        )

    # --- matchup_type ---
    for order, mtype in enumerate(["fbs_vs_fbs", "buy_game", "fcs_vs_fcs"]):
        top = wk1[(wk1["matchup_type"] == mtype) & wk1["is_selected"]]
        if len(top) == 0:
            continue
        records.append({"group_key": "matchup_type", "label": mtype, "n": len(top), "win_rate": float(top["correct"].mean()), "sort_order": order})

    # --- bias_check (FBS-vs-FBS top-15 pool only) ---
    fbs_top = fbs_top.copy()
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

    # --- edge_bucket (FBS-vs-FBS top-15 pool only) - grounds every game's rationale below ---
    edge_buckets: list[tuple[float, float, float, int]] = []
    for order, (lo, hi) in enumerate(EDGE_BUCKETS):
        sub = fbs_top[(fbs_top["edge"].abs() >= lo) & (fbs_top["edge"].abs() < hi)]
        if len(sub) == 0:
            continue
        win_rate = float(sub["correct"].mean())
        label = f"{lo}-{hi}" if hi < 100 else f"{lo}+"
        records.append({"group_key": "edge_bucket", "label": label, "n": len(sub), "win_rate": win_rate, "sort_order": order})
        edge_buckets.append((float(lo), float("inf") if hi >= 100 else float(hi), win_rate, len(sub)))
    edge_buckets.sort()

    # --- edge_type: closing (headline) vs. opening line - does the
    # strategy still hold up on the number a bet placed early in the week
    # actually sees, not just the closing number every other breakdown
    # above uses? Opening-line coverage only exists 2021+ (and partially
    # even then), so this is a smaller, noisier check, not a replacement.
    print("Re-grading against opening lines (edge_type check)...")
    wk1_open = _graded_week1(df, last_complete_season, spread_col="market_spread_open")
    fbs_open_top = _top_n_per_season(wk1_open[wk1_open["matchup_type"] == "fbs_vs_fbs"], TOP_N)
    records.append({"group_key": "edge_type", "label": "closing", "n": len(fbs_top), "win_rate": float(fbs_top["correct"].mean()), "sort_order": 0})
    if len(fbs_open_top) > 0:
        records.append(
            {"group_key": "edge_type", "label": "opening", "n": len(fbs_open_top), "win_rate": float(fbs_open_top["correct"].mean()), "sort_order": 1}
        )
        open_seasons = sorted(int(s) for s in fbs_open_top["season"].unique())
        print(f"  opening-line seasons with real coverage: {open_seasons}")

    client = get_client()
    client.table("model_backtests").delete().eq("model_version", MODEL_VERSION).execute()
    for r in records:
        r["model_version"] = MODEL_VERSION
    for i in range(0, len(records), 500):
        client.table("model_backtests").insert(records[i : i + 500]).execute()
    print(f"Wrote {len(records)} backtest summary rows (model_version={MODEL_VERSION}).")

    # --- per-game rows, every graded week-1 game (all matchup types) ---
    print("Loading team names/ids and coaching continuity for rationale...")
    games_meta = pd.DataFrame(fetch_all("games", "id,home_team,away_team,home_id,away_id"))
    games_meta = games_meta.set_index("id")

    coaching_all = _fetch_seasons("team_coaching", "season,team_id,is_new_coach", list(range(FIRST_TEST_SEASON, last_complete_season + 1)))
    new_coach_lookup = {(row["season"], row["team_id"]): row["is_new_coach"] for _, row in coaching_all.iterrows()} if not coaching_all.empty else {}

    game_records = []
    for r in wk1.itertuples():
        if r.game_id not in games_meta.index:
            continue
        meta = games_meta.loc[r.game_id]
        pick_team = meta["home_team"] if r.pick_home else meta["away_team"]
        opp_team = meta["away_team"] if r.pick_home else meta["home_team"]

        pick_returning, opp_returning = (r.home_returning_ppa_pct, r.away_returning_ppa_pct) if r.pick_home else (r.away_returning_ppa_pct, r.home_returning_ppa_pct)
        pick_talent, opp_talent = (r.home_talent, r.away_talent) if r.pick_home else (r.away_talent, r.home_talent)
        pick_transfers, opp_transfers = (r.home_net_transfer_stars, r.away_net_transfer_stars) if r.pick_home else (r.away_net_transfer_stars, r.home_net_transfer_stars)
        pick_id, opp_id = (meta["home_id"], meta["away_id"]) if r.pick_home else (meta["away_id"], meta["home_id"])
        pick_new_coach = bool(new_coach_lookup.get((r.season, pick_id), False))
        opp_new_coach = bool(new_coach_lookup.get((r.season, opp_id), False))

        pick_mkt, pick_mdl = _pick_spread_view(r.market_spread, r.pred, r.pick_home)
        rationale = _build_rationale(
            pick_team, opp_team, pick_mkt, pick_mdl,
            pick_returning, opp_returning,
            pick_new_coach, opp_new_coach,
            pick_talent, opp_talent,
            pick_transfers, opp_transfers,
            abs(r.edge), edge_buckets,
        )

        game_records.append(
            {
                "model_version": MODEL_VERSION,
                "season": int(r.season),
                "home_team": meta["home_team"],
                "away_team": meta["away_team"],
                "market_spread": float(r.market_spread),
                "predicted_margin": float(r.pred),
                "edge": float(abs(r.edge)),
                "matchup_type": r.matchup_type,
                "pick_team": pick_team,
                "actual_margin": float(r.actual_margin),
                "correct": bool(r.correct),
                "is_selected": bool(r.is_selected),
                "rationale": rationale,
            }
        )
    client.table("model_backtest_games").delete().eq("model_version", MODEL_VERSION).execute()
    for i in range(0, len(game_records), 500):
        client.table("model_backtest_games").insert(game_records[i : i + 500]).execute()
    print(f"Wrote {len(game_records)} per-game backtest rows (model_version={MODEL_VERSION}).")


if __name__ == "__main__":
    run()
