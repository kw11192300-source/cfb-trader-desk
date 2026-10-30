"""Read-only: does the moneyline disagree with the spread in a way that predicts the result?

gap = ML-implied margin - spread-implied margin (closing DK). ML margin = sigma * Phi^-1(no-vig home win prob), sigma fitted on the train half
(so the gap is ~0 on average by construction). Fit resid(actual - close margin) ~ beta*gap on early 60 % of dates, test on the rest.
Run from python/:  .venv/Scripts/python.exe exchange/agents/labs/labm/analysis_mlspread.py
"""
import numpy as np
import pandas as pd
from scipy.stats import norm

D = "data/"


def ml_prob(a):
    a = np.asarray(a, float)
    return np.where(a < 0, -a / (-a + 100), 100 / (a + 100))


def load():
    out = []
    o = pd.read_csv(D + "cbb/closing_odds.csv")
    o = o[o.book.str.contains("DraftKings", na=False)]
    s = pd.read_csv(D + "cbb/schedule.csv", usecols=["event_id", "start_utc", "completed", "home_score", "away_score"])
    m = o.merge(s, on="event_id"); m = m[m.completed == True]
    out.append(pd.DataFrame(dict(sport="cbb", date=m.start_utc, margin=m.home_score - m.away_score, sc=m.spread_home_close, so=m.spread_home_open,
                                 mh=m.ml_home_close, ma=m.ml_away_close)))
    o = pd.read_csv(D + "nba/odds.csv")
    o = o[o.book.str.contains("Draft", na=False)]
    g = pd.read_csv(D + "nba/games.csv", usecols=["event_id", "start_utc", "home_pts", "away_pts"])
    m = o.merge(g, on="event_id")
    out.append(pd.DataFrame(dict(sport="nba", date=m.start_utc, margin=m.home_pts - m.away_pts, sc=m.spread_home_close, so=m.spread_home_open,
                                 mh=m.ml_home_close, ma=m.ml_away_close)))
    df = pd.concat(out, ignore_index=True)
    df["date"] = pd.to_datetime(df.date, utc=True, errors="coerce")
    df = df.dropna(subset=["date", "margin", "sc", "mh", "ma"])
    ph, pa = ml_prob(df.mh), ml_prob(df.ma)
    df["p"] = ph / (ph + pa)
    df["z"] = norm.ppf(df.p.clip(0.005, 0.995))
    df["cm"] = -df.sc
    return df.sort_values("date")


def run(df, sp, max_abs_spread=None):
    d = df[df.sport == sp].copy()
    if max_abs_spread is not None:
        d = d[d.cm.abs() <= max_abs_spread]
    d = d[(d.p > 0.03) & (d.p < 0.97)]  # extreme MLs are noisy/unbettable
    n = len(d); cut = int(n * 0.6)
    tr, te = d.iloc[:cut].copy(), d.iloc[cut:].copy()
    # sigma: regress close margin on z through origin, on train only
    sig = float((tr.z * tr.cm).sum() / (tr.z ** 2).sum())
    for x in (tr, te):
        x["gap"] = sig * x.z - x.cm
        x["res"] = x.margin - x.cm
    b = float((tr.gap * tr.res).sum() / (tr.gap ** 2).sum())
    bte = float((te.gap * te.res).sum() / (te.gap ** 2).sum())
    se = te.res.std() / np.sqrt((te.gap ** 2).sum())
    mse0 = (te.res ** 2).mean()
    out = f"{sp} |spread|<={max_abs_spread}: n={n} sigma {sig:.2f} sd(gap) {d.assign(g=sig*d.z-d.cm).g.std():.2f} | beta train {b:+.3f} test {bte:+.3f} (se {se:.3f}) | test MSE close {mse0:.2f}"
    for bb in (b, b / 2):
        out += f"  b={bb:+.2f}:{((te.res - bb * te.gap) ** 2).mean():.2f}"
    # Win-prob check: is the ML or the spread better calibrated for the straight-up result? (Brier on test, excluding pushes)
    tt = te[te.margin != 0]
    win = (tt.margin > 0).astype(float)
    p_spread = norm.cdf(tt.cm / sig)
    out += f"\n      Brier test: ML {((tt.p - win) ** 2).mean():.4f}  spread {((p_spread - win) ** 2).mean():.4f}  (n {len(tt)})"
    print(out)


if __name__ == "__main__":
    df = load()
    print(df.groupby("sport").date.agg(["count", "min", "max"]))
    for sp in ["cbb", "nba"]:
        run(df, sp)
        run(df, sp, 10)
