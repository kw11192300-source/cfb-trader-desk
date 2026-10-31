"""The syndicates' rating systems, all fitted from nothing but ESPN final scores.

  elo         margin Elo (a rating is points of margin; updates on every result, carries across the off-season with a pull to the mean)
  ridge_long  home/away offence + defence ridge regression with a long memory (half-life in weeks)
  ridge_short the same with a short memory (a "form" model)
Each engine predicts a home margin and a total for any matchup of teams it has seen, or None if it hasn't seen one of them.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import spsolve

# per-sport knobs: ridge penalty (in decayed games), long / short half-life (days), Elo k, Elo home edge, Elo margin cap, total mean-shrink
PARAMS = {
    "nba": dict(lam=8.0, hl_long=150, hl_short=45, k=0.07, hca=2.8, cap=25, n0=10),
    "cbb": dict(lam=6.0, hl_long=120, hl_short=40, k=0.07, hca=3.5, cap=30, n0=10),
    "nfl": dict(lam=8.0, hl_long=300, hl_short=90, k=0.10, hca=2.0, cap=28, n0=6),
    "cfb": dict(lam=5.0, hl_long=250, hl_short=70, k=0.10, hca=2.5, cap=35, n0=6),
    "nhl": dict(lam=30.0, hl_long=150, hl_short=45, k=0.03, hca=0.25, cap=4, n0=16),
}
ENGINES = ("elo", "ridge_long", "ridge_short")


def _t(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() / 86400.0


def fit_ridge(sport: str, games: list[dict], half_life: float, asof: float | None = None) -> dict:
    P = PARAMS[sport]
    asof = asof if asof is not None else datetime.now(timezone.utc).timestamp() / 86400.0
    teams: dict[str, int] = {}
    for g in games:
        teams.setdefault(g["home"]["id"], len(teams))
        teams.setdefault(g["away"]["id"], len(teams))
    T, n = len(teams), len(games)
    if n < 20:
        return {}
    h0 = P["hca"] / 2.0  # prior home edge per side: the data only moves it a little (blowouts of small schools at home otherwise inflate it)
    rows, cols, vals, y, w = [], [], [], [], []
    for i, g in enumerate(games):
        wt = 0.5 ** (max(0.0, asof - _t(g["start"])) / half_life)
        h, a = teams[g["home"]["id"]], teams[g["away"]["id"]]
        ha = 0.0 if g["neutral"] else 1.0
        for r, (off, dfn, sign, sc) in enumerate(((h, a, 1.0, g["home"]["score"]), (a, h, -1.0, g["away"]["score"]))):
            row = 2 * i + r
            rows += [row, row, row, row]
            cols += [0, 1, 2 + off, 2 + T + dfn]
            vals += [1.0, sign * ha, 1.0, 1.0]
            y.append(sc - sign * ha * h0)
            w.append(wt)
    X = sp.csr_matrix((vals, (rows, cols)), shape=(2 * n, 2 + 2 * T))
    y, w = np.array(y, float), np.array(w)
    lam = np.full(2 + 2 * T, P["lam"])
    lam[0] = 1e-6
    lam[1] = 400.0
    A = (X.T @ sp.diags(w) @ X + sp.diags(lam)).tocsc()
    beta = spsolve(A, X.T @ (w * y))
    inv = {j: k for k, j in teams.items()}
    return {"mu": round(float(beta[0]), 4), "hca": round(float(beta[1]) + h0, 4), "n": n,
            "teams": {inv[j]: [round(float(beta[2 + j]), 3), round(float(beta[2 + T + j]), 3)] for j in range(T)}}


def fit_elo(sport: str, games: list[dict]) -> dict:
    P = PARAMS[sport]
    r: dict[str, float] = {}
    last: dict[str, float] = {}
    tot_sum: dict[str, float] = {}
    tot_n: dict[str, float] = {}
    all_tot = [g["home"]["score"] + g["away"]["score"] for g in games]
    if len(games) < 20:
        return {}
    mu_t = float(np.mean(all_tot))
    for g in games:
        h, a, d = g["home"]["id"], g["away"]["id"], _t(g["start"])
        for tm in (h, a):  # a long gap (the off-season) pulls a rating most of the way back to average
            if tm in last and d - last[tm] > 90:
                r[tm] = r.get(tm, 0.0) * 0.6
                tot_sum[tm] *= 0.5
                tot_n[tm] *= 0.5
            last[tm] = d
        hca = 0.0 if g["neutral"] else P["hca"]
        pred = r.get(h, 0.0) - r.get(a, 0.0) + hca
        err = float(np.clip(g["home"]["score"] - g["away"]["score"] - pred, -P["cap"], P["cap"]))
        r[h] = r.get(h, 0.0) + P["k"] * err
        r[a] = r.get(a, 0.0) - P["k"] * err
        tot = g["home"]["score"] + g["away"]["score"]
        for tm in (h, a):
            tot_sum[tm] = tot_sum.get(tm, 0.0) + (tot - mu_t)
            tot_n[tm] = tot_n.get(tm, 0.0) + 1.0
    n0 = P["n0"]
    return {"mu_t": round(mu_t, 3), "hca": P["hca"], "n": len(games),
            "teams": {tm: [round(r[tm], 3), round(tot_sum[tm] / (tot_n[tm] + n0), 3)] for tm in r}}


# ---------------------------------------------------------------- the situation model: what rest, back-to-backs, byes, road trips and a busy week do to a game
# It is an adjustment, not a rating: the view is DraftKings' price plus the effects of the schedule spot, so it disagrees with the rating systems for a different reason.
SIT = {"nba": dict(low=1.6, long=4.0, clip=(3.0, 6.0)), "nhl": dict(low=1.6, long=4.0, clip=(0.4, 0.5)), "cbb": dict(low=1.6, long=5.0, clip=(3.0, 6.0)),
       "nfl": dict(low=5.5, long=12.0, clip=(3.0, 4.0)), "cfb": dict(low=5.5, long=12.0, clip=(3.0, 5.0))}
SIT_M = ["low_diff", "long_diff", "road_a", "road_h", "busy_diff"]
SIT_T = ["low_sum", "long_sum", "busy_sum"]


def _team_state(hist: list, t: float, cfg: dict) -> dict:
    """What a team's schedule looks like going into a game at day `t`: days of rest, a short turnaround, a long break, the road trip it is on, games in the last week."""
    prev = [x for x in hist if x[0] < t - 0.01]
    if not prev:
        return {"low": 0.0, "long": 0.0, "road": 0.0, "busy": 0.0}
    rest = t - prev[-1][0]
    road = 0
    for x in reversed(prev):
        if x[1]:
            break
        road += 1
    return {"low": 1.0 if rest <= cfg["low"] else 0.0, "long": 1.0 if rest >= cfg["long"] else 0.0, "road": float(min(road, 4)), "busy": float(min(sum(1 for x in prev if x[0] >= t - 7.0), 4))}


def _sit_row(h: dict, a: dict) -> tuple[list[float], list[float]]:
    return ([h["low"] - a["low"], h["long"] - a["long"], a["road"], h["road"], h["busy"] - a["busy"]], [h["low"] + a["low"], h["long"] + a["long"], h["busy"] + a["busy"]])


def fit_situation(sport: str, games: list[dict]) -> dict:
    cfg = SIT[sport]
    if len(games) < 150:
        return {}
    hist: dict[str, list] = {}
    teams: dict[str, int] = {}
    rows_m, rows_t, ym, yt, hs = [], [], [], [], []
    for g in sorted(games, key=lambda e: e["start"]):
        t = _t(g["start"])
        h, a = g["home"]["id"], g["away"]["id"]
        teams.setdefault(h, len(teams))
        teams.setdefault(a, len(teams))
        fm, ft = _sit_row(_team_state(hist.get(h, []), t, cfg), _team_state(hist.get(a, []), t, cfg))
        rows_m.append(fm)
        rows_t.append(ft)
        ym.append(g["home"]["score"] - g["away"]["score"])
        yt.append(g["home"]["score"] + g["away"]["score"])
        hs.append((teams[h], teams[a], 0.0 if g["neutral"] else 1.0))
        hist.setdefault(h, []).append((t, True))
        hist.setdefault(a, []).append((t, False))
    n, T = len(ym), len(teams)

    def solve(F, y, sign_away: float, lam_f: float) -> np.ndarray:
        F = np.array(F, float)
        X = np.zeros((n, 1 + T + F.shape[1]))
        for i, (h, a, ha) in enumerate(hs):
            X[i, 0] = ha
            X[i, 1 + h] += 1.0
            X[i, 1 + a] += sign_away
        X[:, 1 + T:] = F
        lam = np.concatenate([[1e-6], np.full(T, 3.0), np.full(F.shape[1], lam_f)])
        y = np.array(y, float)
        if sign_away > 0:  # totals: a constant instead of a home edge
            X[:, 0] = 1.0
        return np.linalg.solve(X.T @ X + np.diag(lam), X.T @ y)[1 + T:]

    bm = solve(rows_m, ym, -1.0, 60.0)
    bt = solve(rows_t, yt, 1.0, 60.0)
    last = {tid: [[round(x[0], 3), x[1]] for x in h[-8:]] for tid, h in hist.items()}
    return {"n": n, "m": {k: round(float(v), 4) for k, v in zip(SIT_M, bm)}, "t": {k: round(float(v), 4) for k, v in zip(SIT_T, bt)}, "last": last}


def situation_delta(pl: dict | None, sport: str, home_id: str, away_id: str, start: str) -> tuple[float, float] | None:
    """The adjustment to DraftKings' expected home margin and total for this schedule spot, or None when the teams' schedules are not known."""
    if not pl or home_id not in pl["last"] or away_id not in pl["last"]:
        return None
    cfg = SIT[sport]
    t = _t(start)
    fm, ft = _sit_row(_team_state([tuple(x) for x in pl["last"][home_id]], t, cfg), _team_state([tuple(x) for x in pl["last"][away_id]], t, cfg))
    dm = sum(pl["m"][k] * v for k, v in zip(SIT_M, fm))
    dt = sum(pl["t"][k] * v for k, v in zip(SIT_T, ft))
    return float(np.clip(dm, -cfg["clip"][0], cfg["clip"][0])), float(np.clip(dt, -cfg["clip"][1], cfg["clip"][1]))


def fit_all(sport: str, games: list[dict]) -> dict[str, dict]:
    P = PARAMS[sport]
    return {"elo": fit_elo(sport, games), "ridge_long": fit_ridge(sport, games, P["hl_long"]), "ridge_short": fit_ridge(sport, games, P["hl_short"]), "situation": fit_situation(sport, games)}


def predict(engine: str, pl: dict | None, home_id: str, away_id: str, neutral: bool) -> tuple[float, float] | None:
    """(expected home margin, expected total) or None when the engine doesn't know a team."""
    if not pl:
        return None
    tm = pl["teams"]
    if home_id not in tm or away_id not in tm:
        return None
    if engine == "elo":
        hca = 0.0 if neutral else pl["hca"]
        return tm[home_id][0] - tm[away_id][0] + hca, pl["mu_t"] + tm[home_id][1] + tm[away_id][1]
    oh, dh = tm[home_id]
    oa, da = tm[away_id]
    ha = 0.0 if neutral else pl["hca"]
    hs, as_ = pl["mu"] + ha + oh + da, pl["mu"] - ha + oa + dh
    return hs - as_, hs + as_
