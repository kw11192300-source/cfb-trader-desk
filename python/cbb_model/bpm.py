"""
Box-score player value, in the spirit of Barttorvik's / Daniel Myers' BPM: a player's value is a linear function of his
per-40-minute box-score line, with weights learned by regressing TEAM adjusted offence and defence (ratings.py, season-end,
no prior) on the minutes-weighted sum of its players' lines. Because it is fit at the team level over eight seasons it works
wherever we have box scores (play-by-play substitutions exist only for the last two seasons), and by construction

    team offence (pts/100 above average)  ~  sum over players of  (share of the team's floor time) x offence value
    team defence (pts/100 allowed above avg) ~ the same with defence value

so a roster's strength can be assembled from its players - the basis for preseason projections and for pricing an injury.

Usage:
    python -m cbb_model.bpm build          # player_seasons.csv + team_season_targets.csv
    python -m cbb_model.bpm evaluate       # leave-one-season-out fit quality
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from .parse import PLAYER_GAMES_OUT, TEAM_GAMES_OUT
from .ratings import Config, fit
from .ingest import DATA_DIR

PLAYER_SEASONS_OUT = DATA_DIR / "player_seasons.csv"
TARGETS_OUT = DATA_DIR / "team_season_targets.csv"

STATS = ["pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "ast", "tov", "stl", "blk", "pf"]
MIN_SHRINK = 150.0  # minutes of "league average" mixed into a player's per-40 line so tiny samples don't dominate


def build_player_seasons() -> pd.DataFrame:
    pg = pd.read_csv(PLAYER_GAMES_OUT, low_memory=False)
    pg = pg[pg["min"] > 0]
    agg = pg.groupby(["season", "team_id", "player_id"]).agg(
        name=("name", "last"), pos=("pos", "last"), g=("event_id", "nunique"), min=("min", "sum"), starts=("starter", "sum"), **{s: (s, "sum") for s in STATS}
    ).reset_index()
    team_min = agg.groupby(["season", "team_id"])["min"].transform("sum")
    agg["team_min"] = team_min
    agg["f"] = agg["min"] / (team_min / 5.0)  # share of the team's floor time; sums to 5 over a roster
    return agg


def build_targets() -> pd.DataFrame:
    tg = pd.read_csv(TEAM_GAMES_OUT)
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    rows = []
    cfg = Config(lam_eff=1.0, lam_tempo=3.0, prior_keep=0.0)
    for s in sorted(tg["season"].unique()):
        g = tg[tg["season"] == s]
        r = fit(tg, g["start_utc"].max() + pd.Timedelta(days=1), cfg, prior=None, season=int(s))
        if r is None:
            continue
        for t in r.off:
            rows.append({"season": int(s), "team_id": t, "off": r.off[t], "de": r.de[t], "tempo": r.tempo[t], "games": r.n_games[t], "mu": r.mu})
    return pd.DataFrame(rows)


def per40(ps: pd.DataFrame) -> pd.DataFrame:
    """Per-40 rates shrunk toward the league line by minutes."""
    league = ps[STATS].sum() / ps["min"].sum() * 40.0
    out = ps.copy()
    w = ps["min"] / (ps["min"] + MIN_SHRINK)
    for s in STATS:
        rate = ps[s] / ps["min"].clip(lower=1) * 40.0
        out[f"x_{s}"] = w * rate + (1 - w) * league[s]
    return out


def team_features(ps40: pd.DataFrame) -> pd.DataFrame:
    xs = [f"x_{s}" for s in STATS]
    weighted = ps40[xs].mul(ps40["f"], axis=0)
    weighted["season"] = ps40["season"]
    weighted["team_id"] = ps40["team_id"]
    return weighted.groupby(["season", "team_id"])[xs].sum().reset_index()


def ridge(X: np.ndarray, y: np.ndarray, lam: float) -> np.ndarray:
    Xc = np.c_[np.ones(len(X)), X]
    reg = np.eye(Xc.shape[1]) * lam
    reg[0, 0] = 0.0
    return np.linalg.solve(Xc.T @ Xc + reg, Xc.T @ y)


def evaluate() -> None:
    ps = pd.read_csv(PLAYER_SEASONS_OUT)
    tgt = pd.read_csv(TARGETS_OUT)
    tf = team_features(per40(ps))
    d = tf.merge(tgt, on=["season", "team_id"])
    d = d[d["games"] >= 15]
    xs = [f"x_{s}" for s in STATS]
    X = d[xs].to_numpy()
    print(f"{len(d):,} team-seasons")
    for target in ("off", "de"):
        y = d[target].to_numpy()
        pred = np.zeros(len(d))
        for s in sorted(d["season"].unique()):
            m = (d["season"] == s).to_numpy()
            b = ridge(X[~m], y[~m], lam=5.0)
            pred[m] = np.c_[np.ones(m.sum()), X[m]] @ b
        r2 = 1 - np.sum((y - pred) ** 2) / np.sum((y - y.mean()) ** 2)
        print(f"  {target}: leave-one-season-out R2 {r2:.3f}, RMSE {np.sqrt(np.mean((y - pred) ** 2)):.2f} (sd of target {y.std():.2f})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["build", "evaluate"])
    a = ap.parse_args()
    if a.what == "build":
        ps = build_player_seasons()
        ps.to_csv(PLAYER_SEASONS_OUT, index=False)
        print(f"player-seasons: {len(ps):,}")
        t = build_targets()
        t.to_csv(TARGETS_OUT, index=False)
        print(f"team-season targets: {len(t):,}")
    else:
        evaluate()


if __name__ == "__main__":
    main()
