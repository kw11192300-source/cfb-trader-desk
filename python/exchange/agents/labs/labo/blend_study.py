"""Read-only study: walk-forward fit of the lab model, joined to historical closing lines, to learn how much of the model to blend into DraftKings.
Writes blend_rows.pkl (one row per test game). Usage: python -m exchange.agents.labs.labo.blend_study [modelmodule]"""
import sys, importlib
import numpy as np, pandas as pd
from exchange.agents.pack import Pack

modname = sys.argv[1] if len(sys.argv) > 1 else "exchange.agents.labs.labo.model"
M = importlib.import_module(modname)
P = Pack()
SRC = {"nba": ("nba/odds.csv", "event_id", "spread_home_close", "total_close", "spread_home_open", "total_open"),
       "cbb": ("cbb/closing_odds.csv", "event_id", "spread_home_close", "total_close", "spread_home_open", "total_open"),
       "nhl": ("nhl/odds.csv.gz", "espn_id", None, "total_close", None, "total_open")}

def lines(sp):
    f, col, sc, tc, so, to = SRC[sp]
    df = pd.read_csv(P.path(*f.split("/")))
    df["id"] = sp + ":" + df[col].astype("Int64").astype(str)
    if sp == "nhl":
        df = df[df.provider.isin(["Draft Kings", "DraftKings", "ESPN BET"])].sort_values("provider").drop_duplicates("id")
    out = pd.DataFrame({"id": df.id, "spread": df[sc] if sc else np.nan, "total": df[tc],
                        "open_spread": df[so] if so else np.nan, "open_total": df[to]})
    return out.drop_duplicates("id")

rows = []
for sp in ["nba", "cbb", "nhl"]:
    g = P.games(sp).merge(lines(sp), on="id", how="inner")
    g = g[g.total.notna()].sort_values("start")
    t0 = g.start.min() + pd.Timedelta(days=30)
    cuts = pd.date_range(t0.normalize(), g.start.max(), freq="14D", tz="UTC")
    for c in cuts:
        test = g[(g.start >= c) & (g.start < c + pd.Timedelta(days=14))]
        if not len(test):
            continue
        pk = Pack(asof=c, lines_ok=False); pk.sports = [sp]
        st = M.fit(pk)
        games = [{"id": r.id, "sport": sp, "home_id": r.home_id, "away_id": r.away_id, "neutral": bool(r.neutral), "start": r.start.isoformat(), "dk": None}
                 for r in test.itertuples()]
        pr = M.predict(st, games)
        ngames = len(pk.games(sp))
        for r in test.itertuples():
            if r.id not in pr: continue
            m, t = pr[r.id]
            rows.append({"sport": sp, "id": r.id, "start": r.start, "cut": c, "n_train": ngames, "mm": m, "mt": t,
                         "spread": r.spread, "total": r.total, "open_spread": r.open_spread, "open_total": r.open_total,
                         "am": r.home_score - r.away_score, "at": r.home_score + r.away_score, "neutral": r.neutral})
        print(sp, c.date(), len(test), flush=True)
df = pd.DataFrame(rows)
df.to_pickle(P.path("..", "exchange", "agents", "labs", "labo", "blend_rows.pkl").resolve() if False else __file__.replace("blend_study.py", "blend_rows.pkl"))
print(len(df))
