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


def fit(pack):
    return {}


def predict(state, games):
    out = {}
    for g in games:
        d = g.get("dk")
        if not d or d.get("spread") is None or d.get("total") is None:
            continue
        sp = g.get("sport")
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
