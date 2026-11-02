"""Read-only: v5 vs v4 on pack.closing() rows with dk + kalshi; NHL total -LL vs DK coin flip, and that other sports are unchanged."""
import sys, math
import numpy as np
from scipy.stats import poisson
sys.path.insert(0, "exchange/agents/labs/labo")
import model as M5, model_v4 as M4
from exchange.agents.pack import Pack
P = Pack(); C = P.closing(); S = M5.fit(P)
gs = [{"id": r.id, "sport": r.sport, "home_id": r.home_id, "away_id": r.away_id, "neutral": False,
       "dk": {"spread": r.spread, "total": r.total, "ml_home": r.ml_home, "ml_away": r.ml_away, "kalshi": r.kalshi}} for r in C.itertuples()]
a, b = M5.predict(S, gs), M4.predict(S, gs)
ch = {sp: 0 for sp in C.sport.unique()}
for g in gs:
    if g["id"] in a and np.abs(np.array(a[g["id"]]) - np.array(b[g["id"]])).max() > 1e-9:
        ch[g["sport"]] += 1
print("games changed by sport", ch)
n = C[C.sport == "nhl"]
for lab, pr in (("v5", a), ("v4", b)):
    ll = [-poisson.logpmf(r.home_score + r.away_score, pr[r.id][1]) for r in n.itertuples() if r.id in pr]
    print(lab, "NHL total -LL (in-sample ratings, all 29)", round(float(np.mean(ll)), 4), len(ll))
