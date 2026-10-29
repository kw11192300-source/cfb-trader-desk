"""Read-only: score blends of model vs DraftKings on blend_rows.pkl."""
import numpy as np, pandas as pd
df = pd.read_pickle(__file__.replace("blend_eval.py", "blend_rows.pkl"))
W = [0, .05, .1, .15, .2, .25, .3, .4, .6]
def slope(y, x):
    x = x - 0; b = (x * y).sum() / (x * x).sum(); r = y - b * x
    se = np.sqrt((r ** 2).sum() / (len(x) - 1) / (x * x).sum()); return b, se
for sp, d in df.groupby("sport"):
    for kind, mk, dk, a in (("margin", "mm", "spread", "am"), ("total", "mt", "total", "at")):
        e = d.dropna(subset=[dk])
        if not len(e): continue
        line = -e[dk] if kind == "margin" else e[dk]
        diff = e[mk] - line
        res = e[a] - line
        maes = {w: np.abs(e[a] - (line + w * diff)).mean() for w in W}
        b, se = slope(res.to_numpy(), diff.to_numpy())
        print(f"{sp} {kind:6} n={len(e):5} |diff| mean {diff.abs().mean():5.2f}  MAE " + " ".join(f"{w}:{v:.3f}" for w, v in maes.items()) + f"  OLS slope {b:+.3f}±{se:.3f}")
        # by early/late (days since season data start) and by |diff| bucket
        q = pd.qcut(diff.abs(), 3, labels=["small", "mid", "big"])
        for lab, h in e.groupby(q, observed=True):
            dd = diff[h.index]; rr = res[h.index]; b2, s2 = slope(rr.to_numpy(), dd.to_numpy())
            print(f"     |diff| {lab:5} n={len(h)} slope {b2:+.3f}±{s2:.3f}")
        half = e.start < e.start.quantile(.5)
        for lab, msk in (("first half", half), ("second half", ~half)):
            b2, s2 = slope(res[msk].to_numpy(), diff[msk].to_numpy()); print(f"     {lab} n={msk.sum()} slope {b2:+.3f}±{s2:.3f}")
