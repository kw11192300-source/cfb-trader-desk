"""
Player ratings: a regularised adjusted plus-minus (RAPM) on the lineup stints from stints.py - the college analogue of the
NHL skater model, and the same idea EvanMiya / Torvik's player metrics are built around.

Each stint is two observations (one per side of the ball), each weighted by the possessions it lasted:

    home points per 100 possessions ~ mu + hca + sum(off of the 5 home players) + sum(def of the 5 away players)
    away points per 100 possessions ~ mu       + sum(off of the 5 away players) + sum(def of the 5 home players)

`off` is how many more points per 100 possessions the team scores with him on the floor vs an average player; `def` is how
many more it ALLOWS (lower = better). A ridge penalty pulls players with little floor time toward average, and older seasons
count for less. A team's efficiency is then  mu + sum over its players of (minutes share of the game) x (rating).

Usage:
    python -m cbb_model.players validate --season 2025         # fit on earlier seasons, score that season's stints
    python -m cbb_model.players fit --season 2026              # ratings as of the start of that season (writes player_ratings.csv)
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr

from .ingest import DATA_DIR
from .stints import STINTS_DIR

RATINGS_OUT = DATA_DIR / "player_ratings.csv"
HOME_COLS = [f"h{i}" for i in range(5)]
AWAY_COLS = [f"a{i}" for i in range(5)]

SEASON_WEIGHTS = [1.0, 0.55, 0.30]  # last season, the one before, the one before that
LAMBDA = 2500.0  # ridge strength, in possessions of "average player" prior (see validate)


def load_stints(seasons: list[int]) -> pd.DataFrame:
    frames = []
    for s in seasons:
        p = STINTS_DIR / f"stints_{s}.csv.gz"
        if p.exists():
            f = pd.read_csv(p)
            f["season"] = s
            frames.append(f)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def fit_rapm(stints: pd.DataFrame, weight_by_season: dict[int, float], lam: float = LAMBDA):
    """Returns (player_ids, off, def, mu, hca, possessions_by_player)."""
    s = stints
    w_season = s["season"].map(weight_by_season).to_numpy(dtype=float)
    keep = (w_season > 0) & (s["poss"].to_numpy() > 0.3)
    s = s[keep]
    w_season = w_season[keep]
    poss = s["poss"].to_numpy(dtype=float)

    H = s[HOME_COLS].to_numpy()
    A = s[AWAY_COLS].to_numpy()
    pids = np.unique(np.concatenate([H.ravel(), A.ravel()]))
    index = {int(p): i for i, p in enumerate(pids)}
    P = len(pids)
    lookup = np.vectorize(index.get)
    Hi, Ai = lookup(H), lookup(A)
    n = len(s)

    # two rows per stint: home offence, then away offence
    r = np.repeat(np.arange(2 * n), 5)
    rows = np.concatenate([r[: 5 * n], r[: 5 * n], r[5 * n :], r[5 * n :]])
    cols = np.concatenate([Hi.ravel(), Ai.ravel() + P, Ai.ravel(), Hi.ravel() + P])
    X = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(2 * n, 2 * P))
    home_flag = sp.csr_matrix((np.concatenate([np.ones(n), np.zeros(n)]), (np.arange(2 * n), np.zeros(2 * n, dtype=int))), shape=(2 * n, 1))
    X = sp.hstack([X, home_flag]).tocsr()

    y = np.concatenate([s["pts_h"].to_numpy() / poss, s["pts_a"].to_numpy() / poss]) * 100.0
    # a stint's points per 100 possessions is noisy: weight by possessions (and by how recent the season is)
    w = np.concatenate([poss * w_season, poss * w_season])
    ybar = float(np.average(y, weights=w))
    sw = np.sqrt(w)
    sol = lsqr(sp.diags(sw) @ X, sw * (y - ybar), damp=np.sqrt(lam), atol=1e-8, btol=1e-8, iter_lim=300)[0]
    off, de, hca = sol[:P], sol[P : 2 * P], float(sol[-1])
    on_floor = np.bincount(Hi.ravel(), weights=np.repeat(poss, 5), minlength=P) + np.bincount(Ai.ravel(), weights=np.repeat(poss, 5), minlength=P)
    return pids.astype(int), off, de, ybar, hca, on_floor


def validate(season: int, lams: tuple[float, ...] = (800.0, 2500.0, 8000.0)) -> None:
    train_seasons = [season - 1, season - 2, season - 3]
    train = load_stints([s for s in train_seasons if s >= 2018])
    test = load_stints([season])
    if train.empty or test.empty:
        print("missing stints for", season)
        return
    wmap = {s: SEASON_WEIGHTS[i] for i, s in enumerate(train_seasons)}
    print(f"validate {season}: train {len(train):,} stints ({train_seasons}), test {len(test):,} stints", flush=True)
    poss = test["poss"].to_numpy()
    y = np.concatenate([test["pts_h"] / poss, test["pts_a"] / poss]) * 100.0
    w = np.concatenate([poss, poss])
    for lam in lams:
        t0 = time.time()
        pids, off, de, mu, hca, _ = fit_rapm(train, wmap, lam)
        idx = {int(p): i for i, p in enumerate(pids)}

        def lk(cols, arr):
            return np.array([[arr[idx[int(p)]] if int(p) in idx else 0.0 for p in row] for row in cols])

        H, A = test[HOME_COLS].to_numpy(), test[AWAY_COLS].to_numpy()
        pred_h = mu + hca + lk(H, off).sum(1) + lk(A, de).sum(1)
        pred_a = mu + lk(A, off).sum(1) + lk(H, de).sum(1)
        pred = np.concatenate([pred_h, pred_a])
        base = np.concatenate([np.full(len(test), mu + hca), np.full(len(test), mu)])
        mse_m = float(np.average((y - pred) ** 2, weights=w))
        mse_b = float(np.average((y - base) ** 2, weights=w))
        corr = float(np.corrcoef(pred - base, y - base)[0, 1])
        print(f"  lambda {lam:>6.0f}: weighted MSE {mse_m:.1f} vs average-player baseline {mse_b:.1f} ({(1 - mse_m / mse_b) * 100:+.2f}%), corr {corr:+.3f}  [{time.time() - t0:.0f}s]", flush=True)


def fit_as_of(season: int) -> pd.DataFrame:
    """Ratings using the three seasons BEFORE `season` (what is known at its start)."""
    seasons = [season - 1, season - 2, season - 3]
    stints = load_stints([s for s in seasons if s >= 2018])
    wmap = {s: SEASON_WEIGHTS[i] for i, s in enumerate(seasons)}
    pids, off, de, mu, hca, on_floor = fit_rapm(stints, wmap)
    df = pd.DataFrame({"player_id": pids, "off": off, "def": de, "poss": on_floor})
    df["net"] = df["off"] - df["def"]
    df["mu"] = mu
    df["as_of_season"] = season
    return df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["validate", "fit"])
    ap.add_argument("--season", type=int, default=2025)
    a = ap.parse_args()
    if a.what == "validate":
        validate(a.season)
    else:
        df = fit_as_of(a.season)
        df.to_csv(RATINGS_OUT, index=False)
        print(f"{len(df):,} players rated as of {a.season} -> {RATINGS_OUT}")


if __name__ == "__main__":
    main()
