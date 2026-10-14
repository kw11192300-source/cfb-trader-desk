"""
Accurate player ratings, built the way the best public metrics are (EvanMiya's BPR, Barttorvik's / Ben Alamar-style RAPM+box):

  1. LINEUP IMPACT. A ridge regression on lineup stints (stints.py) gives each player's offence and defence impact adjusted
     for who he played with and against - what the team did with him on the floor vs off it, untangled across thousands of
     stints. It is the only direct measurement of a player's effect, but it is noisy for anyone with limited floor time.
  2. BOX-SCORE MODEL TRAINED ON THAT. A regression of the stage-1 impact on each player's box-score line (per 40 minutes),
     weighted by how much floor time backs each impact estimate. Unlike a team-level regression, this is learned at the
     PLAYER level, so it knows a rebound-heavy big man's box line is worth less than his raw counting stats suggest.
     It extends the ratings to every player-season, including the ones without lineup data (ESPN logs substitutions for
     2025 and part of 2024 only).
  3. POSTERIOR. Stage 1 again, but ridge-shrunk toward the box-score prediction instead of toward zero. A player with lots of
     lineup evidence keeps his measured impact; one with little is pulled to what his box line says. Strength is chosen by
     predicting held-out stints.

Everything is judged on one thing: how well it predicts the points of stints it never saw.

Usage:
    python -m cbb_model.rapm evaluate        # fit on earlier games, score the last ~12% of 2025 games
    python -m cbb_model.rapm fit             # fit on all lineup data, write player_ratings_v2.csv
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr

from .bpm import PLAYER_SEASONS_OUT, STATS, per40
from .ingest import DATA_DIR, SCHEDULE_CSV
from .stints import STINTS_DIR

OUT = DATA_DIR / "player_ratings_v2.csv"
HOME = [f"h{i}" for i in range(5)]
AWAY = [f"a{i}" for i in range(5)]
SEASONS = {2025: 1.0, 2024: 0.8}  # lineup data exists for these two (2024 partially)
XS = [f"x_{s}" for s in STATS]


def load_stints() -> pd.DataFrame:
    frames = []
    for s in SEASONS:
        f = pd.read_csv(STINTS_DIR / f"stints_{s}.csv.gz")
        f["season"] = s
        frames.append(f)
    st = pd.concat(frames, ignore_index=True)
    sched = pd.read_csv(SCHEDULE_CSV, usecols=["event_id", "start_utc"])
    st = st.merge(sched, on="event_id", how="left")
    st["start_utc"] = pd.to_datetime(st["start_utc"], utc=True)
    return st[st["poss"] > 0.3].reset_index(drop=True)


def fit_rapm(stints: pd.DataFrame, pids: np.ndarray, lam: float, prior_off: np.ndarray | None = None, prior_def: np.ndarray | None = None):
    """Ridge toward a prior mean (zero if none). Returns off, def, mu, hca arrays indexed like `pids`."""
    index = {int(p): i for i, p in enumerate(pids)}
    P = len(pids)
    look = np.vectorize(index.get)
    Hi, Ai = look(stints[HOME].to_numpy()), look(stints[AWAY].to_numpy())
    n = len(stints)
    r = np.repeat(np.arange(2 * n), 5)
    rows = np.concatenate([r[: 5 * n], r[: 5 * n], r[5 * n :], r[5 * n :]])
    cols = np.concatenate([Hi.ravel(), Ai.ravel() + P, Ai.ravel(), Hi.ravel() + P])
    X = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(2 * n, 2 * P))
    flag = sp.csr_matrix((np.concatenate([np.ones(n), np.zeros(n)]), (np.arange(2 * n), np.zeros(2 * n, dtype=int))), shape=(2 * n, 1))
    X = sp.hstack([X, flag]).tocsr()

    poss = stints["poss"].to_numpy(dtype=float)
    ws = stints["season"].map(SEASONS).to_numpy(dtype=float)
    y = np.concatenate([stints["pts_h"].to_numpy() / poss, stints["pts_a"].to_numpy() / poss]) * 100.0
    w = np.concatenate([poss * ws, poss * ws])
    ybar = float(np.average(y, weights=w))
    base = np.zeros(2 * P + 1)
    if prior_off is not None:
        base[:P] = prior_off
    if prior_def is not None:
        base[P : 2 * P] = prior_def
    resid = y - ybar - X @ base
    sw = np.sqrt(w)
    sol = lsqr(sp.diags(sw) @ X, sw * resid, damp=np.sqrt(lam), atol=1e-8, btol=1e-8, iter_lim=400)[0]
    out = base + sol
    return out[:P], out[P : 2 * P], ybar, float(out[-1]), poss, Hi, Ai


def predict_mse(stints: pd.DataFrame, pids: np.ndarray, off: np.ndarray, de: np.ndarray, mu: float, hca: float) -> float:
    index = {int(p): i for i, p in enumerate(pids)}

    def rating(cols: np.ndarray, arr: np.ndarray) -> np.ndarray:
        flat = np.array([arr[index[int(p)]] if int(p) in index else 0.0 for p in cols.ravel()])
        return flat.reshape(cols.shape).sum(1)

    H, A = stints[HOME].to_numpy(), stints[AWAY].to_numpy()
    ph = mu + hca + rating(H, off) + rating(A, de)
    pa = mu + rating(A, off) + rating(H, de)
    poss = stints["poss"].to_numpy()
    y = np.concatenate([stints["pts_h"] / poss, stints["pts_a"] / poss]) * 100.0
    w = np.concatenate([poss, poss])
    return float(np.average((y - np.concatenate([ph, pa])) ** 2, weights=w))


def box_features(pids: np.ndarray) -> pd.DataFrame:
    """Per-40 box-score line for each player, pooled over the lineup-era seasons, shrunk by minutes."""
    ps = pd.read_csv(PLAYER_SEASONS_OUT)
    ps = ps[ps["season"].isin(SEASONS)]
    agg = ps.groupby("player_id")[["min"] + STATS].sum().reset_index()
    league = agg[STATS].sum() / agg["min"].sum() * 40.0
    shrink = 150.0
    w = agg["min"] / (agg["min"] + shrink)
    out = pd.DataFrame({"player_id": agg["player_id"]})
    for s in STATS:
        out[f"x_{s}"] = w * (agg[s] / agg["min"].clip(lower=1) * 40.0) + (1 - w) * league[s]
    out["min"] = agg["min"]
    return out.set_index("player_id").reindex(pids)


def ridge_w(X: np.ndarray, y: np.ndarray, w: np.ndarray, lam: float) -> np.ndarray:
    A = np.c_[np.ones(len(X)), X]
    W = w[:, None]
    R = np.eye(A.shape[1]) * lam
    R[0, 0] = 0.0
    return np.linalg.solve(A.T @ (A * W) + R, A.T @ (y * w))


def two_stage(train: pd.DataFrame, lam1: float = 1500.0, lam_box: float = 30.0, min_poss: float = 400.0):
    """Stage 1 + stage 2: returns (pids, stage1 off/def, on-floor possessions, box coefficients, box-predicted off/def)."""
    pids = np.unique(np.concatenate([train[HOME].to_numpy().ravel(), train[AWAY].to_numpy().ravel()]))
    off1, de1, mu, hca, poss, Hi, Ai = fit_rapm(train, pids, lam1)
    on = np.bincount(Hi.ravel(), weights=np.repeat(poss, 5), minlength=len(pids)) + np.bincount(Ai.ravel(), weights=np.repeat(poss, 5), minlength=len(pids))
    bf = box_features(pids)
    ok = (on >= min_poss) & bf[XS].notna().all(axis=1).to_numpy()
    Xraw = bf[XS].to_numpy()
    mu_x, sd_x = np.nanmean(Xraw[ok], 0), np.nanstd(Xraw[ok], 0) + 1e-9
    Z = (np.nan_to_num(Xraw, nan=0.0) - mu_x) / sd_x
    wts = on[ok] / (on[ok] + 1500.0)  # more floor time behind an estimate = more weight
    b_off = ridge_w(Z[ok], off1[ok], wts, lam_box)
    b_def = ridge_w(Z[ok], de1[ok], wts, lam_box)
    pred_off = np.c_[np.ones(len(Z)), Z] @ b_off
    pred_def = np.c_[np.ones(len(Z)), Z] @ b_def
    return pids, off1, de1, mu, hca, on, (b_off, b_def, mu_x, sd_x), pred_off, pred_def, ok


def player_level_weights(upto: int) -> dict | None:
    """The stage-2 box-score weights (trained on lineup impact at the PLAYER level) using only lineup seasons before `upto`
    - the form bpm/preseason consume: {"off": [intercept, w...], "de": [...], "mu_x": ..., "sd_x": ...} on standardised
    per-40 features. None when no lineup season precedes `upto`."""
    st = load_stints()
    st = st[st["season"] < upto]
    if st.empty:
        return None
    global SEASONS
    saved = SEASONS
    SEASONS = {s: w for s, w in saved.items() if s < upto}
    try:
        pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(st)
    finally:
        SEASONS = saved
    b_off, b_def, mu_x, sd_x = box
    return {"off": b_off, "de": b_def, "mu_x": mu_x, "sd_x": sd_x}


def evaluate() -> None:
    st = load_stints()
    cut = st["start_utc"].quantile(0.88)
    train, test = st[st["start_utc"] < cut].reset_index(drop=True), st[st["start_utc"] >= cut].reset_index(drop=True)
    print(f"train {len(train):,} stints, test {len(test):,} stints (last ~12% of games)", flush=True)
    t0 = time.time()
    pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(train)
    print(f"stage 1+2 in {time.time() - t0:.0f}s: {int(ok.sum()):,} players with enough floor time for the box model", flush=True)

    # how well does the box line explain measured impact? (in-sample on those players, weighted)
    for name, y, p in (("off", off1, p_off), ("def", de1, p_def)):
        r2 = 1 - np.sum((y[ok] - p[ok]) ** 2) / np.sum((y[ok] - y[ok].mean()) ** 2)
        print(f"  box model vs lineup impact ({name}): R2 {r2:.2f}, corr {np.corrcoef(y[ok], p[ok])[0, 1]:.2f}", flush=True)

    base = predict_mse(test, pids, np.zeros_like(off1), np.zeros_like(de1), mu, hca)
    print(f"held-out stint MSE:  average-player baseline {base:.1f}", flush=True)
    m = predict_mse(test, pids, p_off - p_off.mean(), p_def - p_def.mean(), mu, hca)
    print(f"  box model only (no lineup data used for the player): {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
    for lam1 in (500.0, 1500.0, 5000.0):
        o, d, mu1, h1, *_ = fit_rapm(train, pids, lam1)
        m = predict_mse(test, pids, o, d, mu1, h1)
        print(f"  stage-1 RAPM only, shrunk to zero, lambda {lam1:>6.0f}: {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
    po, pd_ = p_off - p_off.mean(), p_def - p_def.mean()
    best = None
    for lam in (150.0, 400.0, 1000.0, 2500.0, 6000.0):
        o, d, mu2, h2, *_ = fit_rapm(train, pids, lam, prior_off=po, prior_def=pd_)
        m = predict_mse(test, pids, o, d, mu2, h2)
        print(f"  posterior (box prior + lineups), lambda {lam:>6.0f}: {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
        if best is None or m < best[0]:
            best = (m, lam)
    print(f"best posterior lambda: {best[1]:.0f}", flush=True)


def fit_all(lam_post: float) -> pd.DataFrame:
    st = load_stints()
    pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(st)
    po, pd_ = p_off - p_off.mean(), p_def - p_def.mean()
    o, d, *_ = fit_rapm(st, pids, lam_post, prior_off=po, prior_def=pd_)
    df = pd.DataFrame({"player_id": pids, "off": o, "def": d, "prior_off": po, "prior_def": pd_, "raw_off": off1, "raw_def": de1, "poss": on})
    df["net"] = df["off"] - df["def"]
    b_off, b_def, mu_x, sd_x = box
    coef = pd.DataFrame({"feature": ["intercept"] + XS, "off": b_off, "def": b_def})
    coef.to_csv(DATA_DIR / "box_model_player_level.csv", index=False)
    return df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate", "fit"])
    ap.add_argument("--lam", type=float, default=1000.0)
    a = ap.parse_args()
    if a.what == "evaluate":
        evaluate()
    else:
        df = fit_all(a.lam)
        df.to_csv(OUT, index=False)
        print(f"{len(df):,} players -> {OUT}")


if __name__ == "__main__":
    main()
