"""
NBA player ratings from lineups - the way EPM / BPM+RAPM / DARKO are built, from public data only (box scores + play-by-play):

  1. LINEUP IMPACT. A ridge regression on lineup stints (stints.py) gives each player's offence and defence impact in points per
     100 possessions, adjusted for who he played with and against. The only direct measurement of a player's effect, but noisy.
  2. BOX-SCORE MODEL TRAINED ON THAT, at the PLAYER level: a regression of stage-1 impact on each player's box line (per 36
     minutes, shrunk by minutes), weighted by how much floor time backs each estimate. It extends the ratings to players the
     lineups barely measure and supplies the prior in stage 3.
  3. POSTERIOR. Stage 1 again, shrunk toward the box prediction instead of toward zero: a player with lots of lineup evidence keeps
     his measured impact; one with little is pulled to what his box line says. Recent seasons count more (half-life, in seasons).

Scale: points per 100 possessions a player adds when he replaces an average player, on the floor (five +1s make a +5 lineup).
`off` is offence; `def` is points ALLOWED (negative = good); `net` = off - def.

Judged on one thing: how well it predicts the points of stints it never saw.

    python -m nba_model.rapm evaluate      # next-season and late-season holdouts
    python -m nba_model.rapm fit           # fit on everything, write data/nba/player_ratings.csv
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr

from .ingest import DATA_DIR
from .parse import GAMES_OUT, PLAYER_GAMES_OUT
from .stints import STINTS_DIR

OUT = DATA_DIR / "player_ratings.csv"
HOME = [f"h{i}" for i in range(5)]
AWAY = [f"a{i}" for i in range(5)]
RAW_STATS = ["pts", "fga", "fta", "tpm", "tpa", "ast", "tov", "oreb", "dreb", "stl", "blk", "pf"]
XS = [f"x_{s}" for s in RAW_STATS] + ["x_ts", "x_mpg"]


def load_stints(first: int = 2021, last: int = 2100) -> pd.DataFrame:
    frames = []
    for s in range(first, last + 1):
        path = STINTS_DIR / f"stints_{s}.csv.gz"
        if path.exists():
            f = pd.read_csv(path)
            f["season"] = s
            frames.append(f)
    st = pd.concat(frames, ignore_index=True)
    gm = pd.read_csv(GAMES_OUT, usecols=["event_id", "start_utc"])
    st = st.merge(gm, on="event_id", how="left")
    st["start_utc"] = pd.to_datetime(st["start_utc"], utc=True)
    for c in HOME + AWAY:
        st[c] = st[c].astype("int64")
    return st[st["poss"] > 0.3].reset_index(drop=True)


def season_weights(seasons, as_of: int, half_life: float) -> dict[int, float]:
    return {int(s): float(0.5 ** (max(as_of - s, 0) / half_life)) for s in seasons}


def fit_rapm(stints: pd.DataFrame, pids: np.ndarray, lam: float, sw: dict[int, float], prior_off: np.ndarray | None = None, prior_def: np.ndarray | None = None):
    """Ridge toward a prior mean (zero if none). Returns off, def, mu, hca, possessions, home/away index arrays."""
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
    ws = stints["season"].map(sw).to_numpy(dtype=float)
    y = np.concatenate([stints["pts_h"].to_numpy() / poss, stints["pts_a"].to_numpy() / poss]) * 100.0
    w = np.concatenate([poss * ws, poss * ws])
    ybar = float(np.average(y, weights=w))
    base = np.zeros(2 * P + 1)
    if prior_off is not None:
        base[:P] = prior_off
    if prior_def is not None:
        base[P : 2 * P] = prior_def
    resid = y - ybar - X @ base
    sqw = np.sqrt(w)
    sol = lsqr(sp.diags(sqw) @ X, sqw * resid, damp=np.sqrt(lam), atol=1e-8, btol=1e-8, iter_lim=600)[0]
    out = base + sol
    return out[:P], out[P : 2 * P], ybar, float(out[-1]), poss * ws, Hi, Ai


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


def box_features(pids: np.ndarray, sw: dict[int, float], event_ids: set | None = None, shrink: float = 300.0) -> pd.DataFrame:
    """Per-36 box line for each player pooled over the seasons (recent ones weighted more), shrunk toward the league by minutes.
    `event_ids` restricts the games used, so a holdout evaluation never sees the games it predicts."""
    pg = pd.read_csv(PLAYER_GAMES_OUT)
    pg = pg[pg["min"] > 0]
    if event_ids is not None:
        pg = pg[pg["event_id"].isin(event_ids)]
    w = pg["season"].map(sw).fillna(0.0)
    cols = ["min"] + RAW_STATS
    agg = (pg[cols].mul(w, axis=0)).groupby(pg["player_id"]).sum()
    games = pg.groupby("player_id")["event_id"].nunique()
    league = agg[RAW_STATS].sum() / agg["min"].sum() * 36.0
    m = agg["min"]
    lam = m / (m + shrink)
    out = pd.DataFrame(index=agg.index)
    for s in RAW_STATS:
        out[f"x_{s}"] = lam * (agg[s] / m.clip(lower=1) * 36.0) + (1 - lam) * league[s]
    out["x_ts"] = out["x_pts"] / (2.0 * (out["x_fga"] + 0.44 * out["x_fta"]).clip(lower=1))
    out["x_mpg"] = (m / games.reindex(agg.index).clip(lower=1)).clip(upper=40)
    out["min"] = m
    return out.reindex(pids)


def ridge_w(X: np.ndarray, y: np.ndarray, w: np.ndarray, lam: float) -> np.ndarray:
    A = np.c_[np.ones(len(X)), X]
    W = w[:, None]
    R = np.eye(A.shape[1]) * lam
    R[0, 0] = 0.0
    return np.linalg.solve(A.T @ (A * W) + R, A.T @ (y * w))


def two_stage(train: pd.DataFrame, sw: dict[int, float], lam1: float = 3000.0, lam_box: float = 30.0, min_poss: float = 600.0):
    """Stage 1 + stage 2: (pids, stage-1 off/def, mu, hca, on-floor possessions, box coefficients, box-predicted off/def, ok mask)."""
    pids = np.unique(np.concatenate([train[HOME].to_numpy().ravel(), train[AWAY].to_numpy().ravel()]))
    off1, de1, mu, hca, wposs, Hi, Ai = fit_rapm(train, pids, lam1, sw)
    on = np.bincount(Hi.ravel(), weights=np.repeat(wposs, 5), minlength=len(pids)) + np.bincount(Ai.ravel(), weights=np.repeat(wposs, 5), minlength=len(pids))
    bf = box_features(pids, sw, event_ids=set(train["event_id"].unique()))
    ok = (on >= min_poss) & bf[XS].notna().all(axis=1).to_numpy()
    Xraw = bf[XS].to_numpy(dtype=float)
    mu_x, sd_x = np.nanmean(Xraw[ok], 0), np.nanstd(Xraw[ok], 0) + 1e-9
    Z = (np.nan_to_num(Xraw, nan=0.0) - mu_x) / sd_x
    wts = on[ok] / (on[ok] + 3000.0)
    b_off = ridge_w(Z[ok], off1[ok], wts, lam_box)
    b_def = ridge_w(Z[ok], de1[ok], wts, lam_box)
    pred_off = np.c_[np.ones(len(Z)), Z] @ b_off
    pred_def = np.c_[np.ones(len(Z)), Z] @ b_def
    return pids, off1, de1, mu, hca, on, (b_off, b_def, mu_x, sd_x), pred_off, pred_def, ok


def _r2(y, p, ok) -> str:
    r2 = 1 - np.sum((y[ok] - p[ok]) ** 2) / np.sum((y[ok] - y[ok].mean()) ** 2)
    return f"R2 {r2:.2f}, corr {np.corrcoef(y[ok], p[ok])[0, 1]:.2f}"


def evaluate_split(st: pd.DataFrame, train: pd.DataFrame, test: pd.DataFrame, label: str, as_of: int, half_life: float) -> None:
    print(f"\n=== {label}: train {len(train):,} stints, test {len(test):,} stints", flush=True)
    sw = season_weights(sorted(train["season"].unique()), as_of, half_life)
    t0 = time.time()
    pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(train, sw)
    print(f"  stage 1+2 in {time.time() - t0:.0f}s: {int(ok.sum()):,} players with enough floor time for the box model", flush=True)
    print(f"  box model vs lineup impact: offence {_r2(off1, p_off, ok)} | defence {_r2(de1, p_def, ok)}", flush=True)
    base = predict_mse(test, pids, np.zeros_like(off1), np.zeros_like(de1), mu, hca)
    print(f"  held-out stint MSE: average-player baseline {base:.1f}", flush=True)
    po, pdf = p_off - p_off.mean(), p_def - p_def.mean()
    m = predict_mse(test, pids, po, pdf, mu, hca)
    print(f"    box model only: {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
    for lam1 in (1000.0, 3000.0, 10000.0):
        o, d, mu1, h1, *_ = fit_rapm(train, pids, lam1, sw)
        m = predict_mse(test, pids, o, d, mu1, h1)
        print(f"    stage-1 RAPM only, lambda {lam1:>6.0f}: {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
    best = None
    for lam in (300.0, 1000.0, 3000.0, 8000.0, 20000.0):
        o, d, mu2, h2, *_ = fit_rapm(train, pids, lam, sw, prior_off=po, prior_def=pdf)
        m = predict_mse(test, pids, o, d, mu2, h2)
        print(f"    posterior (box prior + lineups), lambda {lam:>6.0f}: {m:.1f} ({(1 - m / base) * 100:+.2f}%)", flush=True)
        if best is None or m < best[0]:
            best = (m, lam)
    print(f"  best posterior lambda here: {best[1]:.0f}", flush=True)


def evaluate(half_life: float) -> None:
    st = load_stints()
    last = int(st["season"].max())
    # next season: ratings built from everything before it, tested on all of it
    tr, te = st[st["season"] < last].reset_index(drop=True), st[st["season"] == last].reset_index(drop=True)
    evaluate_split(st, tr, te, f"NEXT SEASON (train 2021-{last - 1}, test {last})", last - 1, half_life)
    # late in a season: everything before the final ~15% of the last season
    cut = st[st["season"] == last]["start_utc"].quantile(0.85)
    tr2, te2 = st[st["start_utc"] < cut].reset_index(drop=True), st[st["start_utc"] >= cut].reset_index(drop=True)
    evaluate_split(st, tr2, te2, f"LATE SEASON (train through {cut:%b %d} {last}, test the last 15%)", last, half_life)


def fit_all(lam_post: float, half_life: float) -> pd.DataFrame:
    st = load_stints()
    last = int(st["season"].max())
    sw = season_weights(sorted(st["season"].unique()), last, half_life)
    pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(st, sw)
    po, pdf = p_off - p_off.mean(), p_def - p_def.mean()
    o, d, *_ = fit_rapm(st, pids, lam_post, sw, prior_off=po, prior_def=pdf)
    df = pd.DataFrame({"player_id": pids, "off": o, "def": d, "prior_off": po, "prior_def": pdf, "raw_off": off1, "raw_def": de1, "poss": on})
    df["net"] = df["off"] - df["def"]
    b_off, b_def, mu_x, sd_x = box
    pd.DataFrame({"feature": ["intercept"] + XS, "off": b_off, "def": b_def}).to_csv(DATA_DIR / "box_model_player_level.csv", index=False)
    return df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate", "fit"])
    ap.add_argument("--lam", type=float, default=3000.0)
    ap.add_argument("--half-life", type=float, default=2.0)
    a = ap.parse_args()
    if a.what == "evaluate":
        evaluate(a.half_life)
    else:
        df = fit_all(a.lam, a.half_life)
        df.to_csv(OUT, index=False)
        print(f"{len(df):,} players -> {OUT}")


if __name__ == "__main__":
    main()
