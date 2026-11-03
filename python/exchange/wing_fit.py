"""Fits how wide the spread of outcomes really is around DraftKings' closing lines, for the Wing Desk's alt-line prices.

The exchange prices every alternate line from one normal curve whose width is fixed per sport (pricing.SIGMA). The real width moves with the game:
a big favourite's margin is more spread out than a close game's, and a high total has a wider spread than a low one. This fits, per sport,

    margin sd = exp(a + b * min(|spread|, cap) / 10)        total sd = exp(a + b * ln(total / league average total))

by maximum likelihood on finished games with DraftKings (or ESPN BET) closing lines, and writes exchange/wing_sigma.json. Run by hand:

    python -m exchange.wing_fit            fit, check on held-out games, write the file
    python -m exchange.wing_fit --dry      fit and check only

Only sports with enough closing-line history are written (college basketball, NBA, college football); the rest keep the engine's width.
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import norm

from .pricing import SIGMA

DATA = Path(__file__).resolve().parents[1] / "data"
OUT = Path(__file__).with_name("wing_sigma.json")
CAP = {"cbb": 20.0, "nba": 15.0, "cfb": 28.0, "nfl": 14.0}
MIN_GAIN = 0.0005  # a curve is used only where it beat the engine's fixed width on games it was not fitted on, by at least this much log likelihood per game


def _cbb() -> pd.DataFrame:
    o = pd.read_csv(DATA / "cbb" / "closing_odds.csv")
    s = pd.read_csv(DATA / "cbb" / "schedule.csv")
    d = o.merge(s[["event_id", "home_score", "away_score"]], on="event_id")
    d = d[d["book"].astype(str).str.contains("raft|ESPN", case=False)]
    return d.rename(columns={"spread_home_close": "spread", "total_close": "total"})[["event_id", "spread", "total", "home_score", "away_score"]]


def _nba() -> pd.DataFrame:
    o = pd.read_csv(DATA / "nba" / "odds.csv")
    s = pd.read_csv(DATA / "nba" / "schedule.csv")
    d = o.merge(s[["event_id", "home_score", "away_score"]], on="event_id")
    return d.rename(columns={"spread_home_close": "spread", "total_close": "total"})[["event_id", "spread", "total", "home_score", "away_score"]]


def _cfb() -> pd.DataFrame:
    d = pd.read_pickle(Path(__file__).resolve().parents[1] / "training_dataset_cache_v3.pkl")
    d = d.dropna(subset=["market_spread", "market_total", "actual_margin", "actual_total"]).copy()
    # market_spread is the home spread (negative when home is favoured); keep it only if the sign agrees with the results
    sign = np.sign(np.corrcoef(d["actual_margin"], -d["market_spread"])[0, 1])
    d["spread"] = d["market_spread"] if sign > 0 else -d["market_spread"]
    d["total"] = d["market_total"]
    d["event_id"] = np.arange(len(d))
    d["home_score"] = (d["actual_total"] + d["actual_margin"]) / 2
    d["away_score"] = (d["actual_total"] - d["actual_margin"]) / 2
    return d[["event_id", "spread", "total", "home_score", "away_score"]]


LOADERS = {"cbb": _cbb, "nba": _nba, "cfb": _cfb}


def _nll(theta: np.ndarray, x: np.ndarray, r: np.ndarray) -> float:
    sd = np.exp(theta[0] + theta[1] * x)
    return float(np.sum(np.log(sd) + 0.5 * (r / sd) ** 2))


def fit_curve(x: np.ndarray, r: np.ndarray, sd0: float) -> tuple[float, float]:
    res = minimize(_nll, np.array([np.log(sd0), 0.0]), args=(x, r), method="Nelder-Mead", options={"xatol": 1e-5, "fatol": 1e-7})
    return float(res.x[0]), float(res.x[1])


def features(sport: str, d: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Margin feature and residual, total feature and residual. The residual is the result measured from the closing line."""
    xm = np.minimum(d["spread"].abs().values, CAP[sport]) / 10.0
    rm = (d["home_score"] - d["away_score"]).values + d["spread"].values
    xt = np.log(d["total"].values / SIGMA[sport][2])
    rt = (d["home_score"] + d["away_score"]).values - d["total"].values
    return xm, rm, xt, rt


def main() -> None:
    dry = "--dry" in sys.argv
    out: dict = {"fitted": date.today().isoformat()}
    for sport, load in LOADERS.items():
        d = load().dropna().drop_duplicates("event_id")
        d = d[(d["total"] > 0)]
        xm, rm, xt, rt = features(sport, d)
        hold = (d["event_id"].astype(int) % 2 == 1).values  # fit on the even half, check on the odd half
        am, bm = fit_curve(xm[~hold], rm[~hold] - rm[~hold].mean(), SIGMA[sport][0])
        at, bt = fit_curve(xt[~hold], rt[~hold] - rt[~hold].mean(), SIGMA[sport][1])
        # held-out log likelihood against the engine's fixed width, per game
        def ll(x, r, a, b):
            sd = np.exp(a + b * x)
            return float(np.mean(norm.logpdf(r - r.mean(), 0, sd)))
        gm = ll(xm[hold], rm[hold], am, bm) - float(np.mean(norm.logpdf(rm[hold] - rm[hold].mean(), 0, SIGMA[sport][0])))
        gt = ll(xt[hold], rt[hold], at, bt) - float(np.mean(norm.logpdf(rt[hold] - rt[hold].mean(), 0, SIGMA[sport][1])))
        # the final fit uses every game
        am, bm = fit_curve(xm, rm - rm.mean(), SIGMA[sport][0])
        at, bt = fit_curve(xt, rt - rt.mean(), SIGMA[sport][1])
        out[sport] = {"n": int(len(d)), "m": {"a": round(am, 5), "b": round(bm, 5), "cap": CAP[sport], "use": gm > MIN_GAIN}, "t": {"a": round(at, 5), "b": round(bt, 5), "ref": SIGMA[sport][2], "use": gt > MIN_GAIN},
                      "holdout_gain": {"m": round(gm, 5), "t": round(gt, 5)}}
        sm = lambda s: float(np.exp(am + bm * min(s, CAP[sport]) / 10.0))
        st = lambda t: float(np.exp(at + bt * np.log(t / SIGMA[sport][2])))
        print(f"{sport}: {len(d)} games | margin sd by |spread| 3/8/15/25: {sm(3):.2f} {sm(8):.2f} {sm(15):.2f} {sm(25):.2f} (engine {SIGMA[sport][0]}) | "
              f"total sd at {SIGMA[sport][2]*0.85:.0f}/{SIGMA[sport][2]:.0f}/{SIGMA[sport][2]*1.15:.0f}: {st(SIGMA[sport][2]*0.85):.2f} {st(SIGMA[sport][2]):.2f} {st(SIGMA[sport][2]*1.15):.2f} (engine {SIGMA[sport][1]}) | "
              f"held-out log-likelihood gain per game: margin {gm:+.4f}, total {gt:+.4f}")
    if not dry:
        OUT.write_text(json.dumps(out, indent=1))
        print("wrote", OUT)


if __name__ == "__main__":
    main()
