"""Market Lab model: DraftKings line plus small, per-sport adjustments learned from historical DK lines.

v2 (2026-10-29): move adjustment. The starter pushed every move 25 % further; on historical DK open/close lines (analysis_moves.py) that made
out-of-sample error worse in 4 of 5 markets. Full-sample move betas (resid after close ~ beta * move):
  cbb spread -0.19 (se 0.10, n 5326)   cbb total -0.18 (se 0.09, n 5326)   nba spread +0.22 (se 0.14, n 2216)
  nba total -0.25 (se 0.06, n 2307; unstable by season)   nhl total -0.11 (se 0.14, n 1090)   nfl/cfb: no data.
BETA below is roughly half of that where two date halves agree in sign, else 0. Moves are clipped to +-3 to blunt stale opens.

v3 (2026-10-30): moneyline vs spread disagreement (analysis_mlspread*.py). gap = margin implied by the no-vig moneyline minus the spread, where
the ML -> margin map is a cubic fit of probit(p) on the spread over historical DK closes. Result ~ ML_BETA * gap:
  cbb n 10400: per season +0.31 (se 0.18), +0.25 (0.16); date split train +0.20, test +0.44 (0.21); test MSE 122.60 -> 122.55 at half beta.
  nba n 2307:  per season +0.94 (0.60), +0.11 (0.54); test +0.08 (0.56) - same sign, noise.  gap sd ~0.8 pts, so a typical nudge is ~0.2 pts.
Gap clipped to +-2; skipped when the ML is beyond 3 %/97 % or |spread| > 20 (cubic map unreliable there).
Caveat: history has only open and close; live, `spread`/`total`/ML are current lines, which may still move before close.

v4 (2026-11-01): NHL fix (analysis_nhl_ml.py). v1-v3 returned -puckline (always +-1.5 goals) as the NHL margin, so every favourite was priced as a
1.5-goal favourite (live: -20 per 1000 Brier vs DK close on 87 NHL prices). Now: total = Poisson mean making the posted total a coin flip, margin =
the one that reproduces the no-vig ML under the engine's Skellam pricing. DK closes 2023-24, n 1302: ML Brier/1000 250.1 -> 232.2 (se 3.6), puckline
248.5 -> 233.7 (se 3.6), both season halves; level with the engine's full-price fit (232.3). ESPN BET n 4222: puckline +12.3 (se 1.8); totals equal (n 3001).
"""
import math
from statistics import NormalDist

PORTABLE = True
BETA = {  # move continuation (spread, total)
    "cbb": (-0.10, -0.10),
    "nba": (0.10, 0.0),
}
CLIP = 3.0
# probit(no-vig home win prob) ~ cubic(home margin implied by spread), fitted on all historical DK closes (np.polyfit order: x^3..x^0)
ML_CUBIC = {
    "cbb": (-3.7e-05, 0.000107, 0.088988, -0.004242),
    "nba": (4e-06, -4.1e-05, 0.076712, 0.002837),
}
ML_BETA = {"cbb": 0.25, "nba": 0.15}
GAP_CLIP = 2.0
_N = NormalDist()


def _clip(x, c=CLIP):
    return max(-c, min(c, x))


def _prob(a):
    a = float(a)
    if a == 0:
        return None
    return -a / (-a + 100.0) if a < 0 else 100.0 / (a + 100.0)


def _ml_gap(sport, m, d):
    """Margin implied by the moneyline minus the spread's margin m (points), or 0 when unusable."""
    c = ML_CUBIC.get(sport)
    if not c or d.get("ml_home") is None or d.get("ml_away") is None or abs(m) > 20:
        return 0.0
    try:
        ph, pa = _prob(d["ml_home"]), _prob(d["ml_away"])
    except (TypeError, ValueError):
        return 0.0
    if ph is None or pa is None or not (ph + pa) > 0:
        return 0.0
    p = ph / (ph + pa)
    if not (0.03 < p < 0.97):
        return 0.0
    f = ((c[0] * m + c[1]) * m + c[2]) * m + c[3]
    slope = max(0.02, (3 * c[0] * m + 2 * c[1]) * m + c[2])
    g = (_N.inv_cdf(p) - f) / slope
    return _clip(g, GAP_CLIP) if math.isfinite(g) else 0.0


def _pois(lam, n=30):
    p = [math.exp(-lam)]
    for k in range(1, n):
        p.append(p[-1] * lam / k)
    return p


def _p_over(t, L):
    """Engine's NHL total price: Poisson(t) over L, pushes refunded."""
    p = _pois(t)
    k, c = math.floor(L), math.ceil(L) - 1
    lo = sum(p[: c + 1])
    hi = 1.0 - sum(p[: k + 1])
    return hi / (hi + lo) if hi + lo > 0 else 0.5


def _p_ml_nhl(m, t):
    """Engine's NHL moneyline: independent Poissons, a regulation tie split half each (OT/shootout)."""
    ph, pa = _pois(max(0.2, (t + m) / 2)), _pois(max(0.2, (t - m) / 2))
    win = tie = 0.0
    for i, a in enumerate(ph):
        tie += a * pa[i]
        win += a * sum(pa[:i])
    return win + 0.5 * tie


def _bis(f, lo, hi, target, n=40):
    for _ in range(n):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) < target else (lo, mid)
    return (lo + hi) / 2


def _nhl_mt(d):
    """v4: the puckline is +-1.5 for nearly every game, so -spread is not a margin. Take the total as the Poisson mean that makes the posted
    total a coin flip, then the margin that reproduces the no-vig moneyline under the engine's own Skellam model. None when the ML is missing."""
    t = _bis(lambda x: _p_over(x, d["total"]), 0.5, 20.0, 0.5)
    try:
        ph, pa = _prob(d["ml_home"]), _prob(d["ml_away"])
    except (TypeError, ValueError, KeyError):
        return None, t
    if ph is None or pa is None:
        return None, t
    p = min(0.97, max(0.03, ph / (ph + pa)))
    return _bis(lambda x: _p_ml_nhl(x, t), -4.0, 4.0, p), t


def fit(pack):
    return {}


def predict(state, games):
    out = {}
    for g in games:
        d = g.get("dk")
        if not d or d.get("spread") is None or d.get("total") is None:
            continue
        sp = g.get("sport")
        if sp == "nhl":
            m, t = _nhl_mt(d)
            if m is not None:
                out[g["id"]] = [m, t]
            continue
        bs, bt = BETA.get(sp, (0.0, 0.0))
        m0, t = -d["spread"], d["total"]
        m = m0
        if d.get("open_spread") is not None:
            m += bs * _clip(m0 - (-d["open_spread"]))
        if d.get("open_total") is not None:
            t += bt * _clip(t - d["open_total"])
        m += ML_BETA.get(sp, 0.0) * _ml_gap(sp, m0, d)
        out[g["id"]] = [m, t]
    return out
