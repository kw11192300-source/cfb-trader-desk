"""Read-only: NHL market-implied Dist parameters vs v1 (which read the +-1.5 puck line as the margin), and how much rating signal to add on top.
Uses blend_rows.pkl (walk-forward raw v1 ratings, no lookahead) joined to nhl/odds.csv.gz DK closes. Scored on the engine's own pricing:
log loss of home win (ml), and Poisson log-lik of the final total."""
import numpy as np, pandas as pd
from scipy.stats import poisson
from exchange.agents.pack import Pack
from exchange.pricing import Dist, devig
P = Pack()
d = pd.read_pickle(__file__.replace("nhl_market.py", "blend_rows.pkl")); d = d[d.sport == "nhl"].copy()
o = pd.read_csv(P.path("nhl", "odds.csv.gz")); o["id"] = "nhl:" + o.espn_id.astype("Int64").astype(str)
o = o[o.provider.isin(["Draft Kings", "DraftKings", "ESPN BET"])].sort_values("provider").drop_duplicates("id")
d = d.merge(o[["id", "ml_home_close", "ml_away_close", "pl_home_close", "over_close", "under_close"]], on="id").dropna(subset=["ml_home_close", "total"])


def bis(f, lo, hi, target, it=50):
    for _ in range(it):
        mid = (lo + hi) / 2
        if f(mid) < target: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def lam_for(L, po):  # Poisson mean whose P(over L) / (P(over)+P(under)) = po
    k = int(np.floor(L))
    return bis(lambda x: poisson.sf(k, x), 0.5, 20, po)


rows = []
for r in d.itertuples():
    po = devig(r.over_close, r.under_close)
    t_j = lam_for(r.total, po if po is not None and not np.isnan(po) else 0.5)
    t_n = lam_for(r.total, 0.5)
    pml = devig(r.ml_home_close, r.ml_away_close)
    m_ml = bis(lambda x: Dist("nhl", x, t_n).p_ml(), -4, 4, pml)
    rows.append((t_j, t_n, m_ml, pml))
d[["t_j", "t_n", "m_ml", "pml"]] = rows
d["hw"] = (d["am"] > 0).astype(float)
print("n", len(d), d.start.min().date(), d.start.max().date())


def ll_ml(m, t):
    p = np.array([Dist("nhl", a, b).p_ml() for a, b in zip(m, t)]).clip(1e-4, 1 - 1e-4)
    return -np.mean(d.hw * np.log(p) + (1 - d.hw) * np.log(1 - p))


def ll_t(t):
    return -np.mean(poisson.logpmf(d["at"].astype(int), np.clip(t, 0.5, None)))


v1m = 0.6 * -d.pl_home_close.fillna(0) + 0.4 * d.mm
v1t = 0.6 * d.total + 0.4 * d.mt
print(f"ML logloss  v1 {ll_ml(v1m, v1t):.4f}  market(ml) {ll_ml(d.m_ml, d.t_n):.4f}  raw ratings {ll_ml(d.mm, d.mt):.4f}")
for w in (0.1, 0.2, 0.3, 0.5):
    print(f"   market + {w} * (ratings - market): {ll_ml(d.m_ml + w * (d.mm - d.m_ml), d.t_n):.4f}")
print(f"total -LL  v1 {ll_t(v1t):.4f}  line-as-mean {ll_t(d.total):.4f}  median-match {ll_t(d.t_n):.4f}  juice-match {ll_t(d.t_j):.4f}  ratings {ll_t(d.mt):.4f}")
for w in (0.1, 0.2, 0.3, 0.5, 0.7):
    print(f"   median-match + {w}*(ratings - it): {ll_t(d.t_n + w * (d.mt - d.t_n)):.4f}   juice-match + {w}*: {ll_t(d.t_j + w * (d.mt - d.t_j)):.4f}")
print("mean actual total", d["at"].mean().round(3), "mean t_n", d.t_n.mean().round(3), "t_j", d.t_j.mean().round(3), "ratings", d.mt.mean().round(3), "v1", v1t.mean().round(3))
print("mean |v1 margin|", v1m.abs().mean().round(3), "mean |m_ml|", d.m_ml.abs().mean().round(3), "actual mean margin", d["am"].mean().round(3))
half = d.start < d.start.quantile(.5)
for lab, msk in (("first", half), ("second", ~half)):
    e = d[msk]
    b = lambda w: -np.mean(poisson.logpmf(e["at"].astype(int), e.t_n + w * (e.mt - e.t_n)))
    print(lab, "total -LL w=0", round(b(0), 4), "w=.3", round(b(.3), 4), "w=.5", round(b(.5), 4))
