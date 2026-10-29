"""Read-only: does the model's NHL total signal survive once the over/under juice is accounted for?"""
import numpy as np, pandas as pd
from exchange.agents.pack import Pack
P = Pack()
df = pd.read_pickle(__file__.replace("nhl_juice.py", "blend_rows.pkl")); d = df[df.sport == "nhl"].copy()
o = pd.read_csv(P.path("nhl", "odds.csv.gz")); o["id"] = "nhl:" + o.espn_id.astype("Int64").astype(str)
o = o[o.provider.isin(["Draft Kings", "DraftKings", "ESPN BET"])].sort_values("provider").drop_duplicates("id")
def ip(a): return np.where(a < 0, -a / (-a + 100), 100 / (a + 100))
o["pover"] = ip(o.over_close) / (ip(o.over_close) + ip(o.under_close))
d = d.merge(o[["id", "pover"]], on="id").dropna(subset=["pover"])
d["res"] = d["at"] - d.total; d["diff"] = d.mt - d.total; d["j"] = d.pover - 0.5
X = np.c_[np.ones(len(d)), d["diff"], d.j]; b, *_ = np.linalg.lstsq(X, d.res, rcond=None)
r = d.res - X @ b; cov = np.linalg.inv(X.T @ X) * (r @ r) / (len(d) - 3)
print("n", len(d), "coef [const, diff, juice]", b.round(3), "se", np.sqrt(np.diag(cov)).round(3))
print("corr diff~juice", np.corrcoef(d["diff"], d.j)[0, 1].round(3))
# implied-mean line: total + k*juice with k from fit, then model blend on top
for w in (0, .2, .4, .6):
    base = d.total + b[2] * d.j
    print(w, "MAE vs juice-adjusted", np.abs(d["at"] - (base + w * (d.mt - base))).mean().round(4), "sq", ((d["at"] - (base + w * (d.mt - base)))**2).mean().round(4))
