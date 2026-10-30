"""Read-only: v1 vs v2 predictions on the historical closing-line rows (blend_rows.pkl, raw ratings in mm/mt)."""
import numpy as np, pandas as pd
from exchange.agents.labs.labo.model import W_LINE
from exchange.agents.pack import Pack
P = Pack()
df = pd.read_pickle(__file__.replace("compare.py", "blend_rows.pkl"))
o = pd.read_csv(P.path("nhl", "odds.csv.gz")); o["id"] = "nhl:" + o.espn_id.astype("Int64").astype(str)
o = o[o.provider.isin(["Draft Kings", "DraftKings", "ESPN BET"])].sort_values("provider").drop_duplicates("id")
o["pl"] = o.pl_home_close
def ip(a): return np.where(a < 0, -a / (-a + 100), 100 / (a + 100))
o["ph"] = ip(o.ml_home_close) / (ip(o.ml_home_close) + ip(o.ml_away_close))
df = df.merge(o[["id", "pl", "ph"]], on="id", how="left")
for sp, d in df.groupby("sport"):
    if sp == "nhl":
        v1m = 0.6 * -d.pl + 0.4 * d.mm; mk = 1.3 * np.log(d.ph / (1 - d.ph))
    else:
        v1m = 0.6 * -d.spread + 0.4 * d.mm; mk = -d.spread
    v1t = 0.6 * d.total + 0.4 * d.mt
    wm, wt = W_LINE[sp]
    v2m = mk + wm * (d.mm - mk); v2t = d.total + wt * (d.mt - d.total)
    ok = v1m.notna() & v2m.notna()
    f = lambda x, y: f"MAE {np.abs(y - x).mean():.3f} RMSE {np.sqrt(((y - x) ** 2).mean()):.3f}"  # noqa: E731
    print(f"{sp} n={ok.sum()} margin v1 {f(v1m[ok], d.am[ok])} | v2 {f(v2m[ok], d.am[ok])} | market {f(mk[ok], d.am[ok])}")
    print(f"{sp}       total  v1 {f(v1t, d['at'])} | v2 {f(v2t, d['at'])} | market {f(d.total, d['at'])}")
