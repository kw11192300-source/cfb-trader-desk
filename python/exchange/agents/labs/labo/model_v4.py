"""Open Lab model: DraftKings' line, converted into the engine's own (margin, total) terms, plus only as much of a ratings view as history says it earns.

Ratings: a recency-weighted offence/defence ridge on ESPN results (unchanged from v1); used alone only when a game has no line.

v2 (2026-10-30). Walk-forward ratings joined to historical DK closes (blend_study.py -> blend_rows.pkl; nhl_market.py, bb_blend_sq.py):
- v1 blended 40 % ratings into every line. Squared error of the margin vs pure DK: cbb 135.9 vs 122.8 (n 4488), nba 206.8 vs 203.4 (n 1101).
  Best ratings weight: cbb margin 0, nba margin 0, nba total ~0.05, cbb total ~0.1 (OLS slope +0.13 se 0.05; both date halves gain at 0.1).
- NHL: v1 read the +-1.5 puck line as the expected margin (|margin| 1.0 vs the moneyline's 0.52). Home-win log loss v1 0.7093, ML-implied 0.6802,
  ML-implied + 0.2 ratings 0.6795 (n 1162). The NHL total is a Poisson mean, so the line is turned into the mean that makes over/under a coin flip
  (Poisson -LL 2.2525 vs 2.2554 for line-as-mean); + 0.4 ratings 2.2490, both date halves agree. Live `dk` has no over/under juice, which explains
  most of that ratings signal (with juice the best weight is ~0.15), so the ratings are partly standing in for it.
- nfl/cfb: no historical lines to test against; weight 0 until the exchange's own closes say otherwise.
"""
import math

import numpy as np
from scipy.stats import poisson, skellam

PORTABLE = True
HALF_LIFE = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 200, "nhl": 120}
LAM = {"nba": 6.0, "cbb": 5.0, "nfl": 8.0, "cfb": 5.0, "nhl": 25.0}
W = {  # weight on (ratings - market) when a line exists: (margin, total)
    "nba": (0.0, 0.0),
    "cbb": (0.0, 0.1),
    "nhl": (0.2, 0.4),
    "nfl": (0.0, 0.0),
    "cfb": (0.0, 0.0),
}


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


def _bisect(f, lo, hi, target, n=50):
    for _ in range(n):
        mid = (lo + hi) / 2
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _devig(a, b):
    def p(o):
        return 100.0 / (o + 100.0) if o > 0 else -o / (-o + 100.0)
    if a is None or b is None or a == 0 or b == 0:
        return None
    pa, pb = p(a), p(b)
    return pa / (pa + pb)


def _nhl_pml(m, t):  # the engine's NHL moneyline: Skellam, a regulation tie split half each way
    lh, la = max(0.2, (t + m) / 2), max(0.2, (t - m) / 2)
    return float(skellam.sf(0, lh, la) + 0.5 * skellam.pmf(0, lh, la))


def _market(sport, d):
    """DraftKings -> (margin, total) in the engine's parameterisation, or None for a part DraftKings has not posted."""
    m = t = None
    if sport == "nhl":
        if d.get("total") is not None:
            k = math.floor(d["total"])
            t = _bisect(lambda x: float(poisson.sf(k, x)), 0.5, 20.0, 0.5)
        p = _devig(d.get("ml_home"), d.get("ml_away"))
        if p is not None:
            tt = t if t is not None else 6.0
            m = _bisect(lambda x: _nhl_pml(x, tt), -4.0, 4.0, min(0.97, max(0.03, p)))
        return m, t
    if d.get("spread") is not None:
        m = -d["spread"]
    if d.get("total") is not None:
        t = d["total"]
    return m, t


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
        if d:
            mm, mt = _market(g["sport"], d)
            wm, wt = W.get(g["sport"], (0.0, 0.0))
            if mm is not None:
                m = mm + wm * (m - mm)
            if mt is not None:
                t = mt + wt * (t - mt)
        out[g["id"]] = [float(m), float(t)]
    return out
