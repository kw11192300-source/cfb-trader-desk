"""Read-only: full-sample and per-season move betas with standard errors (stability check for analysis_moves.py)."""
import numpy as np
from analysis_moves import load

df = load()
df["season"] = df.date.dt.year + (df.date.dt.month >= 8)
for sp in ["cbb", "nba", "nhl"]:
    for kind in ["spread", "total"]:
        d = df[df.sport == sp]
        if kind == "spread":
            d = d.dropna(subset=["sc", "so"]); close, opn, y = -d.sc, -d.so, d.margin
        else:
            d = d.dropna(subset=["tc", "to"]); close, opn, y = d.tc, d.to, d.total
        if len(d) < 200:
            continue
        mv, res = close - opn, y - close
        b = (mv * res).sum() / (mv * mv).sum(); se = res.std() / np.sqrt((mv * mv).sum())
        line = f"{sp} {kind}: all n={len(d)} beta {b:+.3f} se {se:.3f} |"
        for s, g in d.assign(mv=mv, res=res).groupby("season"):
            if len(g) >= 100:
                bb = (g.mv * g.res).sum() / (g.mv ** 2).sum(); ss = g.res.std() / np.sqrt((g.mv ** 2).sum())
                line += f" {s}: n={len(g)} {bb:+.2f}({ss:.2f})"
        print(line)
