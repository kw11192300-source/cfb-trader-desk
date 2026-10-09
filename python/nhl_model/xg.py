"""
Our own expected-goals (xG) model for NHL shot attempts, built from the
shot table parse.py produces. NHL's API publishes no xG, so we derive one
from what it does give us: where the shot was taken (distance/angle to the
net being attacked), shot type, the strength state, and what happened
immediately before (a rebound off a save, a rush out of the neutral zone,
how far the puck traveled since the previous event).

What it covers, deliberately:
  * Unblocked attempts only (goals, shots on goal, misses). A blocked
    shot's recorded location is where it was blocked, not where it was
    taken, so it gets no xG (it still counts in raw shot-attempt totals).
  * Empty-net attempts are excluded - the other team's goalie being out of
    the net is a different game (shooting percentage is several times
    higher), and mixing them in would badly distort xG for teams that trail
    late.
  * Regulation + overtime play only (shootouts are filtered out upstream).

Cross-fitted by season: every shot's xG comes from a model that never saw
that shot's season (4 folds, season-assigned), so an in-sample model isn't
grading its own homework when team ratings are later built from these
numbers. NOTE this still lets a model trained on FUTURE seasons score a past
one - fine for a shot-quality model (the physics of a 25-foot wrist shot
don't drift much), but it's a small leak the results-only backtest should be
read with in mind.

Usage:
    python -m nhl_model.xg
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import log_loss, roc_auc_score

from .ingest import DATA_DIR
from .parse import GAMES_OUT, SHOTS_OUT

SHOTS_XG_OUT = DATA_DIR / "shots_xg.csv.gz"
UNBLOCKED = {"shot-on-goal", "missed-shot", "goal"}
SHOT_PREV = {"shot-on-goal", "missed-shot", "blocked-shot", "goal"}
CATEGORICAL = ["shot_type", "strength", "prev_type", "prev_zone"]
NUMERIC = ["dist", "angle", "prev_dt", "prev_dist", "rebound", "rush", "shooter_home"]
N_FOLDS = 4


def add_features(shots: pd.DataFrame) -> pd.DataFrame:
    s = shots.copy()
    s["strength"] = s["sk_for"].astype("Int64").astype(str) + "v" + s["sk_against"].astype("Int64").astype(str)
    s["rebound"] = (s["prev_type"].isin(SHOT_PREV) & (s["prev_same"] == True) & (s["prev_dt"] <= 3)).astype(int)  # noqa: E712
    s["rush"] = (s["prev_zone"].isin(["N", "D"]) & (s["prev_dt"] <= 4)).astype(int)
    s["shooter_home"] = s["shooter_home"].astype(int)
    for c in CATEGORICAL:
        s[c] = s[c].fillna("none").astype(str)
    return s


def _model() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        max_iter=250, learning_rate=0.08, max_leaf_nodes=31, min_samples_leaf=100,
        l2_regularization=1.0, categorical_features="from_dtype", random_state=0,
    )


def _as_categories(df: pd.DataFrame, cats: dict[str, list[str]]) -> pd.DataFrame:
    x = df[CATEGORICAL + NUMERIC].copy()
    for c in CATEGORICAL:
        x[c] = pd.Categorical(x[c], categories=cats[c])
    return x


def fit_cross_fitted(shots: pd.DataFrame) -> pd.DataFrame:
    """Adds `xg` (NaN for blocked / empty-net / no-geometry attempts)."""
    s = add_features(shots)
    mask = s["event"].isin(UNBLOCKED) & (s["opp_goalie_in"] == 1) & s["dist"].notna() & (s["period"] <= 4)
    train_all = s[mask].copy()
    train_all["fold"] = train_all["season"] % N_FOLDS
    cats = {c: sorted(train_all[c].unique()) for c in CATEGORICAL}

    s["xg"] = np.nan
    for k in range(N_FOLDS):
        tr, te = train_all[train_all["fold"] != k], train_all[train_all["fold"] == k]
        model = _model().fit(_as_categories(tr, cats), tr["is_goal"])
        s.loc[te.index, "xg"] = model.predict_proba(_as_categories(te, cats))[:, 1]
        print(f"  fold {k}: trained on {len(tr):,} attempts, scored {len(te):,}")
    return s


def evaluate(s: pd.DataFrame) -> None:
    d = s[s["xg"].notna()]
    y, p = d["is_goal"], d["xg"].clip(1e-6, 1 - 1e-6)
    base = np.full(len(d), y.mean())
    print(f"\nout-of-fold: {len(d):,} unblocked non-empty-net attempts, {int(y.sum()):,} goals ({y.mean():.4f} per attempt)")
    print(f"  log loss  model {log_loss(y, p):.4f}   vs league-average-only {log_loss(y, base):.4f}")
    print(f"  AUC {roc_auc_score(y, p):.4f}")
    print(f"  total xG {d['xg'].sum():,.0f} vs actual goals {int(y.sum()):,}")
    d = d.assign(bin=pd.qcut(d["xg"], 10, duplicates="drop"))
    cal = d.groupby("bin", observed=True).agg(n=("is_goal", "size"), predicted=("xg", "mean"), actual=("is_goal", "mean"))
    print("  calibration by decile (predicted vs actual goal rate):")
    print(cal.round(4).to_string())
    by_state = d.assign(st=np.where(d["sk_for"] > d["sk_against"], "PP", np.where(d["sk_for"] < d["sk_against"], "PK", "EV"))).groupby("st").agg(
        n=("is_goal", "size"), xg=("xg", "sum"), goals=("is_goal", "sum")
    )
    print("  xG vs goals by strength state:")
    print(by_state.round(1).to_string())


def run() -> None:
    shots = pd.read_csv(SHOTS_OUT, low_memory=False)
    games = pd.read_csv(GAMES_OUT, usecols=["game_id", "season"])
    shots = shots.merge(games, on="game_id", how="left")
    # `season` here is the season-start year (2015 = 2015-16)
    shots["season"] = (shots["season"] // 10000).astype(int)  # NHL season ids look like 20152016
    print(f"{len(shots):,} shot attempts across seasons {sorted(shots['season'].unique())}")
    s = fit_cross_fitted(shots)
    evaluate(s)
    s.to_csv(SHOTS_XG_OUT, index=False)
    print(f"\nwrote {SHOTS_XG_OUT}")


if __name__ == "__main__":
    run()
