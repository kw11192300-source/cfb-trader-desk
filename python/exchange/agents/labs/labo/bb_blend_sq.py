"""Read-only: squared-error version of blend_eval for NBA/CBB (the engine prices basketball with a normal around the mean), with date halves."""
import numpy as np, pandas as pd
df = pd.read_pickle(__file__.replace("bb_blend_sq.py", "blend_rows.pkl"))
for sp in ("nba", "cbb"):
    d = df[df.sport == sp].dropna(subset=["spread", "total"])
    half = d.start < d.start.quantile(.5)
    for kind, mk, ln, a in (("margin", "mm", -d.spread, "am"), ("total", "mt", d.total, "at")):
        for lab, msk in (("all", d.start.notna()), ("h1", half), ("h2", ~half)):
            e = d[msk]; L = ln[msk]
            print(sp, kind, lab, len(e), " ".join(f"{w}:{((e[a] - (L + w * (e[mk] - L))) ** 2).mean():.2f}" for w in (0, .05, .1, .2, .4)))
