"""Puts each rating model on the market's scale, from history (the calibration layer under the firms' prices).

The rating systems (Elo and the two ridge regressions) are regressed toward the mean on purpose, so early in a season they squeeze big favourites toward zero and still squeeze close games.
A firm that prices off an unscaled model looks permanently bearish on favourites: its "opinion" is mostly the squeeze, not information. This replays each system on past seasons exactly as the
exchange fits it (refit every second week on the previous 420 days), pairs each system's margin with DraftKings' closing spread, and fits a straight line from one to the other for each phase of the
season and, in college basketball, each tier distance between the two teams (0 for two teams of the same tier, 2 for a power team against a small school). The same method that cut the exchange's
opening-line miss in college basketball from 12 to 5 points (exchange/seed_fit.py), now applied to every system separately.

    python -m exchange.modelcal_fit cbb nba          replay, check on the latest season, write exchange/model_calib.json
    python -m exchange.modelcal_fit cbb --dry        check only

Only systems that can be replayed from ESPN results are calibrated here: elo, ridge_long, ridge_short, and blend (their average). Agent labs and the site's own models are not (see combiner.py).
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from . import ratings
from .seed_fit import ANCHOR, DATA, PHASES, STEP_DAYS, WINDOW_DAYS, add_day, add_tiers, load

OUT = Path(__file__).with_name("model_calib.json")
ENGINES = ("elo", "ridge_long", "ridge_short", "blend")
MIN_GAIN = 0.03  # a fitted line is used only if it cut the miss on the held-out season by at least this share (margin and total are judged separately)


def replay(sport: str, years: list[int]) -> pd.DataFrame:
    games, closes = load(sport)
    cl = closes.set_index("event_id")
    P = ratings.PARAMS[sport]
    starts = np.array([g["start"][:10] for g in games])
    rows = []
    for year in years:
        d0 = date(year, 11, 1) if sport == "cbb" else date(year, 10, 22)
        d = d0
        while d < date(year + 1, 4, 8):
            lo = (d - timedelta(days=WINDOW_DAYS)).isoformat()
            hi, nxt = d.isoformat(), (d + timedelta(days=STEP_DAYS)).isoformat()
            hist = [g for g, st in zip(games, starts) if lo <= st < hi]
            target = [g for g, st in zip(games, starts) if hi <= st < nxt and g["id"] in cl.index]
            if len(hist) > 400 and target:
                asof = pd.Timestamp(hi, tz="UTC").timestamp() / 86400.0
                pl = {"elo": ratings.fit_elo(sport, hist), "ridge_long": ratings.fit_ridge(sport, hist, P["hl_long"], asof), "ridge_short": ratings.fit_ridge(sport, hist, P["hl_short"], asof)}
                for g in target:
                    ps = {e: ratings.predict(e, pl[e], g["home"]["id"], g["away"]["id"], g["neutral"]) for e in ("elo", "ridge_long", "ridge_short")}
                    have = [p for p in ps.values() if p]
                    if len(have) < 2:
                        continue
                    c = cl.loc[g["id"]]
                    row = {"year": year, "date": g["start"][:10], "dk_m": -float(c["spread_home_close"]), "dk_t": float(c["total_close"]), "home_id": g["home"]["id"], "away_id": g["away"]["id"],
                           "margin": g["home"]["score"] - g["away"]["score"], "total": g["home"]["score"] + g["away"]["score"]}
                    for e, p in ps.items():
                        row[f"{e}_m"], row[f"{e}_t"] = (p[0], p[1]) if p else (np.nan, np.nan)
                    row["blend_m"], row["blend_t"] = float(np.mean([p[0] for p in have])), float(np.mean([p[1] for p in have]))
                    rows.append(row)
            d += timedelta(days=STEP_DAYS)
        print(f"  {sport} {year}: {sum(1 for r in rows if r['year'] == year)} games replayed", flush=True)
    return pd.DataFrame(rows)


def fit_engine(train: pd.DataFrame, sport: str, eng: str) -> dict | None:
    t = train.rename(columns={f"{eng}_m": "raw_m", f"{eng}_t": "raw_t"}).dropna(subset=["raw_m", "raw_t"])
    phases = []
    for lo, hi, centre in PHASES[sport]:
        s = t[(t["day"] >= lo) & (t["day"] < hi)]
        if len(s) < 120:
            continue
        b, a = np.polyfit(s["raw_t"].values, s["dk_t"].values, 1)
        ph = {"lo": lo, "hi": hi, "centre": centre, "n": int(len(s)), "total": [round(float(b), 4), round(float(a), 3)], "dist": {}}
        for d in (0, 1, 2):
            sd = s[s["dist"] == d] if sport == "cbb" else s
            if len(sd) < 60:
                sd = s
            sb, sa = np.polyfit(sd["raw_m"].values, sd["dk_m"].values, 1)
            ph["dist"][str(d)] = [round(float(sa), 3), round(float(sb), 4), int(len(sd))]
        phases.append(ph)
    return {"phases": phases} if phases else None


def blend(phases: list[dict], day: float, dist: int) -> tuple[float, float, float, float]:
    cs = [p["centre"] for p in phases]
    if day <= cs[0] or len(phases) == 1:
        mix = [(phases[0], 1.0)]
    elif day >= cs[-1]:
        mix = [(phases[-1], 1.0)]
    else:
        j = max(k for k, c in enumerate(cs) if c <= day)
        w1 = (day - cs[j]) / (cs[j + 1] - cs[j])
        mix = [(phases[j], 1 - w1), (phases[j + 1], w1)]
    a = sum(w * p["dist"][str(dist)][0] for p, w in mix)
    b = sum(w * p["dist"][str(dist)][1] for p, w in mix)
    tb = sum(w * p["total"][0] for p, w in mix)
    ta = sum(w * p["total"][1] for p, w in mix)
    return a, b, tb, ta


def apply(cfg: dict, df: pd.DataFrame, eng: str) -> tuple[np.ndarray, np.ndarray]:
    m, t = df[f"{eng}_m"].values, df[f"{eng}_t"].values
    om, ot = np.full(len(df), np.nan), np.full(len(df), np.nan)
    for i, (day, dist) in enumerate(zip(df["day"].values, df["dist"].values)):
        if np.isnan(m[i]):
            continue
        a, b, tb, ta = blend(cfg["phases"], float(day), int(dist))
        om[i], ot[i] = a + b * m[i], tb * t[i] + ta
    return om, ot


def main() -> None:
    sports = [a for a in sys.argv[1:] if not a.startswith("--")] or ["cbb"]
    dry = "--dry" in sys.argv
    out = json.loads(OUT.read_text()) if OUT.exists() else {}
    for sport in sports:
        years = [2022, 2023, 2025] if sport == "cbb" else [2023, 2025]
        pkl = Path(__file__).resolve().parents[1] / "data" / f"model_replay_{sport}.pkl"
        df = pd.read_pickle(pkl) if pkl.exists() and "--refresh" not in sys.argv else replay(sport, years)
        df.to_pickle(pkl)
        df = add_day(df, sport)
        df = add_tiers(df) if sport == "cbb" else df.assign(dist=0)
        train, test = df[df.year < years[-1]], df[df.year >= years[-1]]
        out[sport] = {"anchor": ANCHOR[sport], "tiers": sport == "cbb", "years": years, "engines": {}}
        print(f"\\n=== {sport}: fitted on {len(train)} earlier games, checked on {len(test)} games of {years[-1]} ===" if False else f"\n=== {sport}: fitted on {len(train)} earlier games, checked on {len(test)} games of {years[-1]} ===")
        for eng in ENGINES:
            cfg = fit_engine(train, sport, eng)
            if not cfg:
                print(f"  {eng}: not enough data")
                continue
            cm, ct = apply(cfg, test, eng)
            ok = ~np.isnan(cm)
            raw_m, raw_t = test[f"{eng}_m"].values[ok], test[f"{eng}_t"].values[ok]
            mae_raw = np.mean(np.abs(raw_m - test["dk_m"].values[ok])); mae_cal = np.mean(np.abs(cm[ok] - test["dk_m"].values[ok]))
            t_raw = np.mean(np.abs(raw_t - test["dk_t"].values[ok])); t_cal = np.mean(np.abs(ct[ok] - test["dk_t"].values[ok]))
            use_total = (t_raw - t_cal) / t_raw >= MIN_GAIN
            print(f"  {eng:<12} n {int(ok.sum()):5d} | margin miss vs DK {mae_raw:5.2f} -> {mae_cal:5.2f} ({100*(mae_raw-mae_cal)/mae_raw:4.0f}% better) | total miss {t_raw:5.2f} -> {t_cal:5.2f}{'  (used)' if use_total else '  (not used)'}")
            full = fit_engine(df, sport, eng)
            full["use_total"] = bool(use_total)
            full["use"] = bool((mae_raw - mae_cal) / mae_raw >= MIN_GAIN)
            out[sport]["engines"][eng] = full
    if not dry:
        OUT.write_text(json.dumps(out, indent=1))
        print("wrote", OUT)


if __name__ == "__main__":
    main()
