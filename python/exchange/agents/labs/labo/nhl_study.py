"""Read-only: NHL - ML-implied margin vs model margin, and what the engine (juice-aware reference) would learn from total outputs."""
import numpy as np, pandas as pd
from exchange.agents.pack import Pack
P = Pack()
df = pd.read_pickle(__file__.replace("nhl_study.py", "blend_rows.pkl")); d = df[df.sport == "nhl"].copy()
o = pd.read_csv(P.path("nhl", "odds.csv.gz")); o["id"] = "nhl:" + o.espn_id.astype("Int64").astype(str)
o = o[o.provider.isin(["Draft Kings", "DraftKings", "ESPN BET"])].sort_values("provider").drop_duplicates("id")
def ip(a): return np.where(a < 0, -a / (-a + 100), 100 / (a + 100))
o["pover"] = ip(o.over_close) / (ip(o.over_close) + ip(o.under_close))
o["ph"] = ip(o.ml_home_close) / (ip(o.ml_home_close) + ip(o.ml_away_close))
d = d.merge(o[["id", "pover", "ph"]], on="id").dropna(subset=["pover", "ph"])
lg = np.log(d.ph / (1 - d.ph))
k = (lg * d.am).sum() / (lg * lg).sum(); print("margin = k*logit(p_home), k =", round(k, 3), "n", len(d))
# out-of-sample k: fit on first half, check second half
h = d.start < d.start.median(); k1 = (lg[h] * d.am[h]).sum() / (lg[h] ** 2).sum(); print("k first half", round(k1, 3))
mk = k1 * lg
for nm, x in (("all", slice(None)), ("2nd half", ~h)):
    diff = (d.mm - mk)[x]; res = (d.am - mk)[x]
    b = (diff * res).sum() / (diff ** 2).sum(); se = np.sqrt(((res - b * diff) ** 2).sum() / len(diff) / (diff ** 2).sum())
    print(nm, "margin slope on (model - ML margin)", round(b, 3), "+-", round(se, 3), "| MAE w:", {w: round(np.abs(res - w * diff).mean(), 4) for w in (0, .1, .25, .5)})
ref = d.total + 6.945 * (d.pover - 0.5)
for w in (0, .15, .3, .5, .6):
    out = d.total + w * (d.mt - d.total); e = out - ref; r = d["at"] - ref
    print("total w", w, "engine slope", round((e * r).sum() / (e * e).sum(), 3) if (e*e).sum() else None, "corr", round(np.corrcoef(e, r)[0, 1], 3))
