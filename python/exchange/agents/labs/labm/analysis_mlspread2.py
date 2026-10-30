"""Read-only: nonlinear version. gapz = z(ML no-vig) - f(close margin), f = cubic fit on train. res ~ b * gapz * slope, slope = local dmargin/dz.
Also per-season sign check. Run from python/."""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from analysis_mlspread import load

df = load()
df["season"] = df.date.dt.year + (df.date.dt.month >= 8)
for sp in ["cbb", "nba"]:
    for cap in (None, 10, 6):
        d = df[(df.sport == sp) & (df.p > 0.03) & (df.p < 0.97)].copy()
        if cap: d = d[d.cm.abs() <= cap]
        n = len(d); cut = int(n * .6); tr, te = d.iloc[:cut].copy(), d.iloc[cut:].copy()
        c = np.polyfit(tr.cm, tr.z, 3)
        for x in (tr, te):
            x["gz"] = x.z - np.polyval(c, x.cm)
            # points per unit z near this margin: 1 / f'(cm)
            x["gap"] = x.gz / np.clip(np.polyval(np.polyder(c), x.cm), 0.02, None)
            x["res"] = x.margin - x.cm
        b = (tr.gap * tr.res).sum() / (tr.gap ** 2).sum(); bt = (te.gap * te.res).sum() / (te.gap ** 2).sum()
        se = te.res.std() / np.sqrt((te.gap ** 2).sum())
        m0 = (te.res ** 2).mean()
        s = f"{sp} cap {cap}: n {n} sd(gap) {te.gap.std():.2f} beta tr {b:+.2f} te {bt:+.2f} (se {se:.2f}) MSE close {m0:.2f} b/2 {((te.res-b/2*te.gap)**2).mean():.2f} b {((te.res-b*te.gap)**2).mean():.2f} 0.5 {((te.res-.5*te.gap)**2).mean():.2f} |"
        allx = pd.concat([tr, te])
        for ss, g in allx.groupby("season"):
            if len(g) > 150:
                s += f" {ss}: n {len(g)} {(g.gap*g.res).sum()/(g.gap**2).sum():+.2f}({g.res.std()/np.sqrt((g.gap**2).sum()):.2f})"
        print(s)
