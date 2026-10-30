"""Fundamentals Lab v2: offence/defence ridge with an anchored home edge and split memory (market-blind).

- The home edge is anchored to a per-sport prior (like the exchange's ridge) so home blowouts of small schools can't inflate it.
- Margins and totals come from two fits with different half-lives: team quality (margin) persists longer than scoring pace (total), most
  clearly in CFB, where programs carry over between seasons (HL_MARGIN 400 days vs 200 for totals).
- SEASON_PRIOR (last season regressed by RHO as the shrinkage target for this season) was tested 2026-10-30 and lost to plain decay; left off.
"""
import numpy as np

PORTABLE = True
HALF_LIFE = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 200, "nhl": 120}
LAM = {"nba": 6.0, "cbb": 5.0, "nfl": 8.0, "cfb": 5.0, "nhl": 25.0}
HCA0 = {"nba": 2.8, "cbb": 3.5, "nfl": 2.0, "cfb": 2.5, "nhl": 0.25}   # prior home margin edge
SEASON_MONTH = {"nba": 9, "cbb": 10, "nfl": 8, "cfb": 7, "nhl": 9}      # a season starts in this month
RHO = {"nba": 0.6, "cbb": 0.6, "nfl": 0.6, "cfb": 0.6, "nhl": 0.6}      # share of last season's rating carried over
SEASON_PRIOR = False
HL_MARGIN = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 400, "nhl": 120}   # margins (team quality) are fitted with their own, longer memory


def _season(start, m0):
    return np.where(start.dt.month.to_numpy() >= m0, start.dt.year.to_numpy(), start.dt.year.to_numpy() - 1)


def _ridge(g, teams, w, lam_t, target, h0):
    T, n = len(teams), len(g)
    X = np.zeros((2 * n, 2 + 2 * T))
    y = np.zeros(2 * n)
    ww = np.zeros(2 * n)
    hi = g.home_id.map(teams).to_numpy()
    ai = g.away_id.map(teams).to_numpy()
    ha = (~g.neutral.to_numpy()).astype(float)
    for r, (o, d, s, sc) in enumerate(((hi, ai, 1.0, g.home_score.to_numpy()), (ai, hi, -1.0, g.away_score.to_numpy()))):
        rows = np.arange(n) * 2 + r
        X[rows, 0] = 1.0
        X[rows, 1] = s * ha
        X[rows, 2 + o] = 1.0
        X[rows, 2 + T + d] = 1.0
        y[rows] = sc - s * ha * h0
        ww[rows] = w
    lam = np.full(2 + 2 * T, lam_t)
    lam[0], lam[1] = 1e-6, 400.0
    tgt = np.zeros(2 + 2 * T)
    tgt[2:] = target
    A = X.T @ (X * ww[:, None]) + np.diag(lam)
    return np.linalg.solve(A, X.T @ (ww * y) + lam * tgt)


def fit(pack):
    return {"tot": _fit(pack, HALF_LIFE), "mar": _fit(pack, HL_MARGIN)}


def _fit(pack, HALF_LIFE):
    state = {}
    for sp in pack.sports:
        g = pack.games(sp)
        if len(g) < 60:
            continue
        teams = {t: i for i, t in enumerate(sorted(set(g.home_id) | set(g.away_id)))}
        T = len(teams)
        h0 = HCA0[sp] / 2.0
        asof = g.start.max()
        season = _season(g.start, SEASON_MONTH[sp])
        cur = season == season.max()
        target = np.zeros(2 * T)
        if SEASON_PRIOR and (~cur).sum() >= 60 and cur.any():
            prev = g[~cur]
            age = (prev.start.max() - prev.start).dt.total_seconds().to_numpy() / 86400.0
            bp = _ridge(prev, teams, 0.5 ** (age / HALF_LIFE[sp]), LAM[sp], np.zeros(2 * T), h0)
            target = RHO[sp] * bp[2:]
            g = g[cur]
            w = 0.5 ** ((asof - g.start).dt.total_seconds().to_numpy() / 86400.0 / HALF_LIFE[sp])
        else:
            w = 0.5 ** ((asof - g.start).dt.total_seconds().to_numpy() / 86400.0 / HALF_LIFE[sp])
        beta = _ridge(g, teams, w, LAM[sp], target, h0)
        state[sp] = {"mu": float(beta[0]), "hca": float(beta[1]) + h0,
                     "o": {t: float(beta[2 + i]) for t, i in teams.items()}, "d": {t: float(beta[2 + T + i]) for t, i in teams.items()}}
    return state


def predict(state, games):
    tot, mar = _predict(state["tot"], games), _predict(state["mar"], games)
    return {k: [mar[k][0], v[1]] for k, v in tot.items() if k in mar}


def _predict(state, games):
    out = {}
    for g in games:
        s = state.get(g["sport"])
        if not s or g["home_id"] not in s["o"] or g["away_id"] not in s["o"]:
            continue
        ha = 0.0 if g["neutral"] else s["hca"]
        h = s["mu"] + ha + s["o"][g["home_id"]] + s["d"][g["away_id"]]
        a = s["mu"] - ha + s["o"][g["away_id"]] + s["d"][g["home_id"]]
        out[g["id"]] = [h - a, h + a]
    return out
