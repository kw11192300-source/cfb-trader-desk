"""Read-only: NHL - does pricing from the no-vig moneyline (and a median-matched total) beat using the puckline number as the margin?
Scores (Brier, per 1000) the engine's own contracts from Dist(m, t) on DraftKings closes in data/nhl/odds.csv.gz:
  A  current v3: m = -puckline (always +-1.5), t = total line
  B  proposed:   m inverted from the no-vig ML (Skellam, as the engine prices), t = Poisson mean with P(over L) = 0.5
  C  ceiling:    engine's pricing.fit on the full snapshot (puckline and over/under prices too, which predict() never sees)
Run from python/:  .venv/Scripts/python.exe -m exchange.agents.labs.labm.analysis_nhl_ml
"""
import numpy as np
import pandas as pd

from exchange import pricing
from exchange.agents.labs.labm import model as M

import sys
BOOK = sys.argv[1] if len(sys.argv) > 1 else "DraftKings"
oa = pd.read_csv("data/nhl/odds.csv.gz")
oa = oa[oa.era == "close"]
cons_t = oa.groupby("game_id").total_close.median()  # other books' total when this book's is missing (margin test only; totals scored only on the book's own)
o = oa[oa.provider == BOOK].dropna(subset=["ml_home_close", "ml_away_close"]).copy()
o["has_t"] = o.total_close.notna()
o["total_close"] = o.total_close.fillna(o.game_id.map(cons_t)).fillna(6.0)
g = pd.read_csv("data/nhl/games.csv.gz")[["game_id", "start_utc", "final_home", "final_away"]]
d = o.merge(g, on="game_id").sort_values("start_utc").reset_index(drop=True)
print(BOOK, "n", len(d), "with own total", int(d.has_t.sum()), d.start_utc.min()[:10], "->", d.start_utc.max()[:10])

rows = []
for r in d.itertuples():
    mar, tot = r.final_home - r.final_away, r.final_home + r.final_away
    L = r.total_close
    pl = r.pl_home_close if r.pl_home_close == r.pl_home_close else (-1.5 if r.ml_home_close < r.ml_away_close else 1.5)
    has_pl = r.pl_home_close == r.pl_home_close and r.pl_home_price_close == r.pl_home_price_close
    outs = {"ml": float(mar > 0), "pl": float(mar > -pl), "tot": float(tot > L)}
    ok_pl = has_pl and (mar + pl) != 0
    snap = {"ml_home": r.ml_home_close, "ml_away": r.ml_away_close, "spread": pl if has_pl else None, "spread_home": r.pl_home_price_close,
            "spread_away": r.pl_away_price_close, "total": L, "over": r.over_close if r.over_close == r.over_close else None, "under": r.under_close if r.under_close == r.under_close else None}
    dc, _ = pricing.fit("nhl", snap)
    dk = {"spread": pl, "total": L, "ml_home": r.ml_home_close, "ml_away": r.ml_away_close, "open_spread": None, "open_total": None}
    mB, tB = M._nhl_mt(dk)
    rec = {"date": r.start_utc[:10]}
    for name, dist in (("A", pricing.Dist("nhl", -pl, L)), ("B", pricing.Dist("nhl", mB, tB)), ("C", dc)):
        rec[name + "_ml"] = (dist.p_ml() - outs["ml"]) ** 2
        rec[name + "_pl"] = (dist.p_spread(pl) - outs["pl"]) ** 2 if ok_pl else np.nan
        rec[name + "_tot"] = (dist.p_total(L) - outs["tot"]) ** 2 if r.has_t else np.nan
    rec["mB"], rec["tB"], rec["mC"], rec["tC"] = mB, tB, dc.m, dc.t
    rows.append(rec)
s = pd.DataFrame(rows)
for k in ("ml", "pl", "tot"):
    line = []
    for a in "ABC":
        line.append(f"{a} {1000 * s[f'{a}_{k}'].mean():.1f}")
    dif = 1000 * (s[f"A_{k}"] - s[f"B_{k}"]).dropna()
    difc = 1000 * (s[f"B_{k}"] - s[f"C_{k}"]).dropna()
    print(f"{k:4s} Brier/1000  " + "  ".join(line) + f"   A-B {dif.mean():+.1f} (se {dif.std() / len(dif) ** .5:.1f})   B-C {difc.mean():+.2f} (se {difc.std() / len(difc) ** .5:.2f})")
h = len(s) // 2
for nm, part in (("first half", s.iloc[:h]), ("second half", s.iloc[h:])):
    print(nm, " ".join(f"{k} A-B {1000 * (part[f'A_{k}'] - part[f'B_{k}']).mean():+.1f}" for k in ("ml", "pl", "tot")))
print("m: B vs engine C  corr %.4f  mean abs diff %.3f;  t: mean B-C %+.3f  sd %.3f" % (
    np.corrcoef(s.mB, s.mC)[0, 1], (s.mB - s.mC).abs().mean(), (s.tB - s.tC).mean(), (s.tB - s.tC).std()))
