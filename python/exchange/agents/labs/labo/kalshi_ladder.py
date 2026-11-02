"""Read-only study: does Kalshi's ladder (P(over L) / P(home covers L) at several lines) give a better mean than DK's line read as a coin flip?

pack.closing() rows: kalshi = [[kind, line, mid, bid, ask, volume], ...]. Kalshi spread rows look like P(home margin > -line)?  -> checked below via sign.
NHL: total = Poisson mean fitted to the ladder; margin from the spread ladder under the engine's Skellam. Basketball/football: ladder median (line where P = 0.5, linear interp).
Scores: NHL total Poisson -LL and Brier of over at DK's line; basketball/football abs error of the mean. Also the v4 lab view (ratings blend) for NHL, walk-forward by day.
"""
import math
import sys
from collections import defaultdict

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from scipy.stats import poisson, skellam

sys.path.insert(0, "exchange/agents/labs/labo")
import model as M  # noqa: E402
from exchange.agents.pack import Pack  # noqa: E402

P = Pack()
C = P.closing()


def ladder(k, kind):
    return [(r[1], r[2], r[5]) for r in (k or []) if r[0] == kind and r[2] is not None and 0.02 < r[2] < 0.98]


def pois_fit(lad):
    if len(lad) < 2:
        return None
    w = np.array([math.log1p(v) + 0.5 for _, _, v in lad])

    def loss(x):
        return float(sum(wi * (poisson.sf(math.floor(L), x) - p) ** 2 for wi, (L, p, _) in zip(w, lad)))
    return minimize_scalar(loss, bounds=(2.0, 12.0), method="bounded").x


def skel_fit(lad, t):  # Kalshi spread rows: line L, p = P(home margin + L > 0)? fit m under both sign conventions, keep the better fit
    if len(lad) < 2:
        return None, None
    best = None
    for sgn in (1, -1):
        def loss(m):
            lh, la = max(0.2, (t + m) / 2), max(0.2, (t - m) / 2)
            return sum((float(skellam.sf(math.floor(-sgn * L), lh, la)) - p) ** 2 for L, p, _ in lad)
        r = minimize_scalar(loss, bounds=(-4, 4), method="bounded")
        if best is None or r.fun < best[1]:
            best = (r.x, r.fun, sgn)
    return best[0], best[2]


def median(lad):
    lad = sorted(lad)
    for (l1, p1, _), (l2, p2, _) in zip(lad, lad[1:]):
        if (p1 - 0.5) * (p2 - 0.5) <= 0 and p1 != p2:
            return l1 + (0.5 - p1) * (l2 - l1) / (p2 - p1)
    return None


# NHL
rows = []
nhl = C[C.sport == "nhl"].sort_values("start")
states = {}
for _, g in nhl.iterrows():
    day = g.start.normalize()
    if day not in states:
        states[day] = M.fit(Pack(asof=day))
    s = states[day]
    gg = {"id": g.id, "sport": "nhl", "home_id": g.home_id, "away_id": g.away_id, "neutral": False,
          "dk": {"spread": g.spread, "total": g.total, "ml_home": g.ml_home, "ml_away": g.ml_away}}
    v4 = M.predict(s, [gg]).get(g.id)
    mdk, tdk = M._market("nhl", gg["dk"])
    tk = pois_fit(ladder(g.kalshi, "total"))
    mk, sgn = skel_fit(ladder(g.kalshi, "spread"), tk or tdk)
    T = g.home_score + g.away_score
    rows.append(dict(id=g.id, line=g.total, T=T, Mg=g.home_score - g.away_score, tdk=tdk, tk=tk, tv4=v4[1] if v4 else None,
                     mdk=mdk, mk=mk, sgn=sgn, mv4=v4[0] if v4 else None))
d = pd.DataFrame(rows)
print("NHL n", len(d), "with kalshi total fit", d.tk.notna().sum(), "spread fit", d.mk.notna().sum(), "spread sign votes", d.sgn.value_counts().to_dict())
print(d[["line", "T", "tdk", "tk", "tv4", "mdk", "mk", "mv4"]].round(2).to_string())
e = d.dropna(subset=["tk", "tv4"])


def nll(mu, T):
    return -poisson.logpmf(T, mu)


def bri(mu, line, T):
    p = poisson.sf(math.floor(line), mu)
    return (p - (T > line)) ** 2


for col in ("tdk", "tk", "tv4"):
    a = np.array([nll(r[col], r["T"]) for _, r in e.iterrows()])
    b = np.array([bri(r[col], r["line"], r["T"]) for _, r in e.iterrows() if r["T"] != r["line"]])
    print(f"total {col}: -LL {a.mean():.4f}  Brier(over at DK line) {b.mean():.4f}  n {len(a)}")
for col in ("tk", "tv4"):
    diff = np.array([nll(r["tdk"], r["T"]) - nll(r[col], r["T"]) for _, r in e.iterrows()])
    print(f"  {col} gain vs tdk -LL {diff.mean():+.4f} se {diff.std(ddof=1) / len(diff) ** .5:.4f}")
print("tk - tdk mean %+.3f sd %.3f ; tv4 - tdk mean %+.3f sd %.3f" % ((e.tk - e.tdk).mean(), (e.tk - e.tdk).std(), (e.tv4 - e.tdk).mean(), (e.tv4 - e.tdk).std()))
print("corr(tk-tdk, T-tdk) %.3f   corr(tv4-tdk, T-tdk) %.3f" % (np.corrcoef(e.tk - e.tdk, e["T"] - e.tdk)[0, 1], np.corrcoef(e.tv4 - e.tdk, e["T"] - e.tdk)[0, 1]))


def hwin(m, t, Mg):
    lh, la = max(0.2, (t + m) / 2), max(0.2, (t - m) / 2)
    p = float(skellam.sf(0, lh, la) + 0.5 * skellam.pmf(0, lh, la))
    return (p - (1.0 if Mg > 0 else 0.0)) ** 2


f = d.dropna(subset=["mk", "mdk"])
for col in ("mdk", "mk", "mv4"):
    print(f"ml Brier {col}: {np.mean([hwin(r[col], r['tdk'], r['Mg']) for _, r in f.iterrows()]):.4f} n {len(f)}")
print("mk - mdk mean %+.3f sd %.3f" % ((f.mk - f.mdk).mean(), (f.mk - f.mdk).std()))

# other sports: ladder median vs DK
for sp in ("nba", "cfb", "nfl", "cbb"):
    out = defaultdict(list)
    for _, g in C[C.sport == sp].iterrows():
        T, Mg = g.home_score + g.away_score, g.home_score - g.away_score
        tm = median(ladder(g.kalshi, "total"))
        if tm is not None and g.total is not None:
            out["t"].append((abs(T - g.total), abs(T - tm), tm - g.total))
        sm = median(ladder(g.kalshi, "spread"))
        if sm is not None and g.spread is not None:
            out["s"].append((g.spread, sm))
    for k, v in out.items():
        v = np.array(v, dtype=float)
        if k == "t":
            print(f"{sp} total n {len(v)}: MAE DK {v[:, 0].mean():.2f} Kalshi-median {v[:, 1].mean():.2f}  gap mean {v[:, 2].mean():+.2f} sd {v[:, 2].std():.2f}")
        else:
            print(f"{sp} spread n {len(v)}: DK spread vs Kalshi median sample {[(round(a, 1), round(b, 1)) for a, b in v[:6]]}")

# sensitivity: t = tdk + a*(tk - tdk) (+ b*(ratings_raw - tdk) via tv4 = tdk + 0.4*(raw - tdk))
print("--- sensitivity (NHL total, n %d) ---" % len(e))
raw = e.tdk + (e.tv4 - e.tdk) / 0.4
half = np.arange(len(e)) < len(e) // 2
for a in (0.0, 0.5, 0.75, 1.0):
    for b in (0.0, 0.15):
        mu = e.tdk + a * (e.tk - e.tdk) + b * (raw - e.tdk)
        g = np.array([nll(e.tdk.iloc[i], e["T"].iloc[i]) - nll(mu.iloc[i], e["T"].iloc[i]) for i in range(len(e))])
        print(f"a {a} b {b}: gain {g.mean():+.4f} se {g.std(ddof=1)/len(g)**.5:.4f}  first half {g[half].mean():+.4f} second {g[~half].mean():+.4f}")
