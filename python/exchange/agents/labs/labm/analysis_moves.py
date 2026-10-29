"""Read-only analysis: do DraftKings open->close moves continue (beta>0) or revert (beta<0) after the close?

resid = actual - close_implied ; move = close_implied - open_implied ; fit resid ~ beta*move (no intercept) on early dates, test on late dates.
Run from python/:  .venv/Scripts/python.exe exchange/agents/labs/labm/analysis_moves.py
"""
import numpy as np
import pandas as pd

D = "data/"


def load():
    out = []
    # CBB
    o = pd.read_csv(D + "cbb/closing_odds.csv")
    o = o[o.book.str.contains("DraftKings", na=False)]
    s = pd.read_csv(D + "cbb/schedule.csv", usecols=["event_id", "start_utc", "completed", "home_score", "away_score"])
    m = o.merge(s, on="event_id")
    m = m[m.completed == True]
    out.append(pd.DataFrame(dict(sport="cbb", date=m.start_utc, margin=m.home_score - m.away_score, total=m.home_score + m.away_score,
                                 sc=m.spread_home_close, so=m.spread_home_open, tc=m.total_close, to=m.total_open)))
    # NBA
    o = pd.read_csv(D + "nba/odds.csv")
    o = o[o.book.str.contains("Draft", na=False)]
    g = pd.read_csv(D + "nba/games.csv", usecols=["event_id", "start_utc", "home_pts", "away_pts"])
    m = o.merge(g, on="event_id")
    out.append(pd.DataFrame(dict(sport="nba", date=m.start_utc, margin=m.home_pts - m.away_pts, total=m.home_pts + m.away_pts,
                                 sc=m.spread_home_close, so=m.spread_home_open, tc=m.total_close, to=m.total_open)))
    # NHL (totals only; spread is a fixed puck line)
    o = pd.read_csv(D + "nhl/odds.csv.gz")
    o = o[o.provider.str.contains("Draft", na=False)]
    g = pd.read_csv(D + "nhl/games.csv.gz", usecols=["game_id", "start_utc", "final_home", "final_away"])
    m = o.merge(g, on="game_id")
    out.append(pd.DataFrame(dict(sport="nhl", date=m.start_utc, margin=m.final_home - m.final_away, total=m.final_home + m.final_away,
                                 sc=np.nan, so=np.nan, tc=m.total_close, to=m.total_open)))
    df = pd.concat(out, ignore_index=True)
    df["date"] = pd.to_datetime(df.date, utc=True, errors="coerce")
    return df.dropna(subset=["date", "margin"])


def fit_beta(x, y, lam=0.0):
    return float((x * y).sum() / ((x * x).sum() + lam))


def study(df, sport, kind):
    if kind == "spread":
        d = df.dropna(subset=["sc", "so"]).copy()
        d["close"], d["open"], d["y"] = -d.sc, -d.so, d.margin
    else:
        d = df.dropna(subset=["tc", "to"]).copy()
        d["close"], d["open"], d["y"] = d.tc, d.to, d.total
    d = d.sort_values("date")
    d["move"] = d.close - d.open
    d["res"] = d.y - d.close
    n = len(d)
    if n < 200:
        print(f"{sport} {kind}: n={n} too small"); return
    cut = int(n * 0.6)
    tr, te = d.iloc[:cut], d.iloc[cut:]
    b = fit_beta(tr.move, tr.res)
    bte = fit_beta(te.move, te.res)
    se = te.res.std() / np.sqrt((te.move ** 2).sum()) if (te.move ** 2).sum() > 0 else np.nan
    mae0 = te.res.abs().mean()
    mae1 = (te.res - b * te.move).abs().mean()
    mse0 = (te.res ** 2).mean(); mse1 = ((te.res - b * te.move) ** 2).mean()
    # starter's beta=0.25
    mse_st = ((te.res - 0.25 * te.move) ** 2).mean()
    print(f"{sport} {kind}: n={n} ({d.date.min().date()}..{d.date.max().date()}), moved {np.mean(d.move!=0):.0%}, mean|move| {d.move.abs().mean():.2f}")
    print(f"   beta train {b:+.3f} | beta test {bte:+.3f} (se {se:.3f}) | test MSE close {mse0:.2f}  fitted {mse1:.2f}  starter0.25 {mse_st:.2f} | MAE {mae0:.3f}->{mae1:.3f}")
    # by move size bucket (whole sample), and sign
    d["bk"] = pd.cut(d.move.abs(), [-0.01, 0.0, 1.0, 2.5, 100], labels=["0", "<=1", "1-2.5", ">2.5"])
    for k, g in d.groupby("bk", observed=True):
        if len(g) >= 50 and k != "0":
            print(f"     |move| {k}: n={len(g)}  beta {fit_beta(g.move, g.res):+.3f}  mean res*sign(move) {np.mean(g.res*np.sign(g.move)):+.2f}")
    # also: does the OPEN carry info beyond close?  same as beta on move, reported above.
    # within-season timing: early season (first 30 days) vs rest
    return d


if __name__ == "__main__":
    df = load()
    print(df.groupby("sport").agg(n=("margin", "size"), so=("so", "count"), to=("to", "count")))
    for sp in ["cbb", "nba", "nhl"]:
        for k in ["spread", "total"]:
            study(df[df.sport == sp], sp, k)
