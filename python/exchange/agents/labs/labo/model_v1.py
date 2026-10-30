"""Starter model for the Open Lab (anything goes): team strength from results, shrunk toward DraftKings when a line is available.

Each team gets an offence and a defence number from a recency-weighted ridge fit of both teams' scores in every game, with a home edge.
This is a starting point for the lab's researcher to replace; it exists so the plumbing (fit -> state -> predict -> exchange) works from day one.
"""
import numpy as np

PORTABLE = True
HALF_LIFE = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 200, "nhl": 120}
LAM = {"nba": 6.0, "cbb": 5.0, "nfl": 8.0, "cfb": 5.0, "nhl": 25.0}


def fit(pack):
    state = {}
    for sp in pack.sports:
        g = pack.games(sp)
        if len(g) < 60:
            continue
        teams = {t: i for i, t in enumerate(sorted(set(g.home_id) | set(g.away_id)))}
        T, n = len(teams), len(g)
        asof = g.start.max()
        age = (asof - g.start).dt.total_seconds().to_numpy() / 86400.0
        w = 0.5 ** (age / HALF_LIFE[sp])
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
            y[rows] = sc
            ww[rows] = w
        lam = np.full(2 + 2 * T, LAM[sp])
        lam[0], lam[1] = 1e-6, 50.0
        A = X.T @ (X * ww[:, None]) + np.diag(lam)
        beta = np.linalg.solve(A, X.T @ (ww * y))
        state[sp] = {"mu": float(beta[0]), "hca": float(beta[1]),
                     "o": {t: float(beta[2 + i]) for t, i in teams.items()}, "d": {t: float(beta[2 + T + i]) for t, i in teams.items()}}
    return state


def predict(state, games):
    out = {}
    for g in games:
        s = state.get(g["sport"])
        if not s or g["home_id"] not in s["o"] or g["away_id"] not in s["o"]:
            continue
        ha = 0.0 if g["neutral"] else s["hca"]
        h = s["mu"] + ha + s["o"][g["home_id"]] + s["d"][g["away_id"]]
        a = s["mu"] - ha + s["o"][g["away_id"]] + s["d"][g["home_id"]]
        m, t = h - a, h + a
        d = g.get("dk")
        if d and d.get("spread") is not None and d.get("total") is not None:
            m, t = 0.6 * -d["spread"] + 0.4 * m, 0.6 * d["total"] + 0.4 * t
        out[g["id"]] = [m, t]
    return out
