"""Calibrates the exchange's own opening line to DraftKings' scale, from history.

Before DraftKings prices a game the exchange opens it at the average of three rating systems (Elo and two ridge regressions, exchange/ratings.py). Those ratings are regressed toward the
mean on purpose, so the line they give is too small for a big favourite: over the first week of games the exchange's line was 44% of DraftKings' on 15-point favourites (11.8 against 26.6)
and still 60 to 70% on close games. This replays the exchange's own method on past seasons and fits the map from its line to DraftKings' closing line.

For each past season, at every second week from November to April, it refits the three systems on the previous 420 days (as the exchange does), predicts the games of the next fortnight,
and pairs each prediction with DraftKings' closing spread and total. The map is fitted on the earlier seasons and checked on the later ones, then refitted on all of them.

    python -m exchange.seed_fit cbb nba        replays and checks, writes exchange/seed_calib.json
    python -m exchange.seed_fit cbb --dry      checks only

The map is monotone and piecewise linear (an isotonic fit smoothed onto a grid), so it can stay close to the identity where the ratings are right (close games) and stretch where they are not.
The total gets a straight line. exchange/engine.py applies both in opening(), and keeps the raw line in the game's ref as raw_mt.
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from . import ratings

DATA = Path(__file__).resolve().parents[1] / "data"
OUT = Path(__file__).with_name("seed_calib.json")
GRID = np.arange(-40.0, 40.1, 2.0)
WINDOW_DAYS = 420
STEP_DAYS = 14


def load(sport: str) -> tuple[list[dict], pd.DataFrame]:
    """Every finished game as the ratings code reads it, and DraftKings' closing lines for the ones that have them."""
    if sport == "cbb":
        s = pd.read_csv(DATA / "cbb" / "schedule.csv")
        o = pd.read_csv(DATA / "cbb" / "closing_odds.csv")
        o = o[o["book"].astype(str).str.contains("raft")]
    else:
        s = pd.read_csv(DATA / "nba" / "schedule.csv")
        o = pd.read_csv(DATA / "nba" / "odds.csv")
        o = o[o["book"].astype(str).str.contains("raft")]
        o = o.rename(columns={"spread_home_close": "spread_home_close", "total_close": "total_close"})
    s = s[(s["completed"] == True) & s["home_score"].notna() & s["away_score"].notna()]  # noqa: E712
    games = [{"id": str(r.event_id), "start": str(r.start_utc), "neutral": bool(r.neutral), "home": {"id": str(r.home_id), "score": int(r.home_score)}, "away": {"id": str(r.away_id), "score": int(r.away_score)}}
             for r in s.itertuples()]
    games.sort(key=lambda g: g["start"])
    o = o.dropna(subset=["spread_home_close", "total_close"]).drop_duplicates("event_id")
    return games, o[["event_id", "spread_home_close", "total_close"]].assign(event_id=lambda d: d["event_id"].astype(str))


def replay(sport: str, years: list[int]) -> pd.DataFrame:
    games, closes = load(sport)
    cl = closes.set_index("event_id")
    P = ratings.PARAMS[sport]
    starts = np.array([g["start"][:10] for g in games])
    rows = []
    for year in years:
        d0 = date(year, 11, 1) if sport == "cbb" else date(year, 10, 22)
        d1 = date(year + 1, 4, 8)
        d = d0
        while d < d1:
            lo = (d - timedelta(days=WINDOW_DAYS)).isoformat()
            hi, nxt = d.isoformat(), (d + timedelta(days=STEP_DAYS)).isoformat()
            hist = [g for g, st in zip(games, starts) if lo <= st < hi]
            target = [g for g, st in zip(games, starts) if hi <= st < nxt and g["id"] in cl.index]
            if len(hist) > 400 and target:
                asof = pd.Timestamp(hi, tz="UTC").timestamp() / 86400.0
                pl = {"elo": ratings.fit_elo(sport, hist), "ridge_long": ratings.fit_ridge(sport, hist, P["hl_long"], asof), "ridge_short": ratings.fit_ridge(sport, hist, P["hl_short"], asof)}
                for g in target:
                    ps = [p for p in (ratings.predict(e, pl[e], g["home"]["id"], g["away"]["id"], g["neutral"]) for e in ratings.ENGINES[:3]) if p]
                    if len(ps) < 2:
                        continue
                    c = cl.loc[g["id"]]
                    rows.append({"year": year, "date": g["start"][:10], "raw_m": float(np.mean([p[0] for p in ps])), "raw_t": float(np.mean([p[1] for p in ps])), "dk_m": -float(c["spread_home_close"]), "dk_t": float(c["total_close"]),
                                 "neutral": g["neutral"], "home_id": g["home"]["id"], "away_id": g["away"]["id"], "margin": g["home"]["score"] - g["away"]["score"], "total": g["home"]["score"] + g["away"]["score"]})
            d += timedelta(days=STEP_DAYS)
        print(f"  {sport} {year}: {sum(1 for r in rows if r['year'] == year)} games replayed", flush=True)
    return pd.DataFrame(rows)


def fit_map(raw: np.ndarray, dk: np.ndarray) -> list[list[float]]:
    """Monotone map from the exchange's margin to DraftKings', as knots on GRID: an isotonic fit, averaged over a sliding window so it has no steps, extended in a straight line past the data."""
    iso = IsotonicRegression(increasing=True, out_of_bounds="clip").fit(raw, dk)
    lo, hi = np.percentile(raw, 1), np.percentile(raw, 99)
    ys = []
    for x in GRID:
        if x < lo or x > hi:
            ys.append(None)
            continue
        win = np.linspace(x - 2.0, x + 2.0, 9)
        ys.append(float(np.mean(iso.predict(np.clip(win, raw.min(), raw.max())))))
    # straight-line extension past the data, at the slope of the last four knots on each side
    xs_ok = [(x, y) for x, y in zip(GRID, ys) if y is not None]
    (xa, ya), (xb, yb) = xs_ok[0], xs_ok[min(3, len(xs_ok) - 1)]
    (xc, yc), (xd, yd) = xs_ok[max(0, len(xs_ok) - 4)], xs_ok[-1]
    s_lo = (yb - ya) / (xb - xa) if xb != xa else 1.0
    s_hi = (yd - yc) / (xd - xc) if xd != xc else 1.0
    out = []
    for x, y in zip(GRID, ys):
        if y is None:
            y = ya + s_lo * (x - xa) if x < xa else yd + s_hi * (x - xd)
        out.append([float(x), round(float(y), 3)])
    # make sure it is monotone after smoothing
    for i in range(1, len(out)):
        out[i][1] = max(out[i][1], out[i - 1][1])
    return out


def apply_map(knots: list[list[float]], x: np.ndarray) -> np.ndarray:
    return np.interp(x, [k[0] for k in knots], [k[1] for k in knots])


PHASES = {  # (low day, high day, centre day) counted from the season's first day: November 1 for college basketball, October 22 for the NBA
    "cbb": [(0, 14, 7), (14, 28, 21), (28, 60, 44), (60, 400, 130)],
    "nba": [(0, 400, 100)],
}
ANCHOR = {"cbb": [11, 1], "nba": [10, 22]}


def add_day(df: pd.DataFrame, sport: str) -> pd.DataFrame:
    m, d = ANCHOR[sport]
    df = df.copy()
    df["day"] = (pd.to_datetime(df["date"]) - pd.to_datetime(df["year"].astype(str) + f"-{m:02d}-{d:02d}")).dt.days
    return df


def add_tiers(df: pd.DataFrame) -> pd.DataFrame:
    """The two teams' conference tiers that season (A power, B top mid-major, C the rest, as exchange/cbbtiers.py) and how far apart they are: 0 for AA, BB, CC, 1 for AB and BC, 2 for AC."""
    from .cbbtiers import A, B

    conf = pd.read_csv(DATA / "cbb" / "conferences.csv")
    tier = {(int(r.season), str(r.team_id)): ("A" if r.conference in A else "B" if r.conference in B else "C") for r in conf.itertuples()}
    df = df.copy()
    ta = [tier.get((int(y), str(t)), "C") for y, t in zip(df["year"], df["home_id"])]
    tb = [tier.get((int(y), str(t)), "C") for y, t in zip(df["year"], df["away_id"])]
    df["dist"] = [abs("ABC".index(x) - "ABC".index(y)) for x, y in zip(ta, tb)]
    return df


def fit_phases(train: pd.DataFrame, sport: str) -> list[dict]:
    """Per phase of the season, a straight line from the exchange's margin to DraftKings' for each tier distance (college basketball: early in the season the ratings squeeze a mismatch
    between a power-conference team and a small school to a third of what DraftKings has), and a straight line for the total."""
    out = []
    for lo, hi, centre in PHASES[sport]:
        t = train[(train["day"] >= lo) & (train["day"] < hi)]
        if len(t) < 150:
            continue
        b, a = np.polyfit(t["raw_t"].values, t["dk_t"].values, 1)
        ph = {"lo": lo, "hi": hi, "centre": centre, "n": int(len(t)), "total": [round(float(b), 4), round(float(a), 3)], "dist": {}}
        for d in (0, 1, 2):
            td = t[t["dist"] == d] if "dist" in t else t
            if len(td) < 60:
                td = t
            sb, sa = np.polyfit(td["raw_m"].values, td["dk_m"].values, 1)
            ph["dist"][str(d)] = [round(float(sa), 3), round(float(sb), 4), int(len(td))]
        out.append(ph)
    return out


def apply_phases(phases: list[dict], day: np.ndarray, dist: np.ndarray, m: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The same blend the engine uses (exchange/seedcal.py): the line of the phase the day sits in, and between two phase centres a mix of the two."""
    cs = [p["centre"] for p in phases]
    mo, to = np.zeros(len(m)), np.zeros(len(t))
    for i, d in enumerate(day):
        if d <= cs[0] or len(phases) == 1:
            ps = [(phases[0], 1.0)]
        elif d >= cs[-1]:
            ps = [(phases[-1], 1.0)]
        else:
            j = max(k for k, c in enumerate(cs) if c <= d)
            w1 = (d - cs[j]) / (cs[j + 1] - cs[j])
            ps = [(phases[j], 1 - w1), (phases[j + 1], w1)]
        mo[i] = sum(wt * (p["dist"][str(int(dist[i]))][0] + p["dist"][str(int(dist[i]))][1] * m[i]) for p, wt in ps)
        to[i] = sum(wt * (p["total"][0] * t[i] + p["total"][1]) for p, wt in ps)
    return mo, to


def report(train: pd.DataFrame, test: pd.DataFrame, sport: str, label: str) -> list[dict]:
    phases = fit_phases(train, sport)
    t = test.copy()
    print()
    t["cal_m"], t["cal_t"] = apply_phases(phases, t["day"].values, t["dist"].values, t["raw_m"].values, t["raw_t"].values)
    print(f"{label}: fitted on {len(train)} games, checked on {len(test)}")
    print(f"  margin vs DraftKings' close: raw {np.mean(np.abs(t.raw_m - t.dk_m)):5.2f} -> calibrated {np.mean(np.abs(t.cal_m - t.dk_m)):5.2f}   | total: raw {np.mean(np.abs(t.raw_t - t.dk_t)):5.2f} -> {np.mean(np.abs(t.cal_t - t.dk_t)):5.2f} (mean error {np.mean(t.raw_t - t.dk_t):+.2f} -> {np.mean(t.cal_t - t.dk_t):+.2f})")
    for lo, hi, lab in [(p[0], p[1], f"day {p[0]}-{min(p[1], 200)}") for p in PHASES[sport]]:
        s = t[(t.day >= lo) & (t.day < hi)]
        if len(s) < 30:
            continue
        sg = np.where(s.dk_m >= 0, 1, -1)
        print(f"  {lab:<12} n {len(s):5d} | miss vs DK: raw {np.mean(np.abs(s.raw_m - s.dk_m)):5.2f} -> {np.mean(np.abs(s.cal_m - s.dk_m)):5.2f} | favourite margin as a share of DK's: raw {np.mean(sg*s.raw_m)/np.mean(sg*s.dk_m):4.0%} -> {np.mean(sg*s.cal_m)/np.mean(sg*s.dk_m):4.0%}")
        for blo, bhi, bl in ((0, 8, "spread under 8"), (8, 15, "8 to 15"), (15, 99, "15+")):
            q = s[(s.dk_m.abs() >= blo) & (s.dk_m.abs() < bhi)]
            if len(q) >= 25:
                print(f"      {bl:<15} n {len(q):4d}  raw miss {np.mean(np.abs(q.raw_m - q.dk_m)):5.2f} -> calibrated {np.mean(np.abs(q.cal_m - q.dk_m)):5.2f}")
    return phases


def main() -> None:
    sports = [a for a in sys.argv[1:] if not a.startswith("--")] or ["cbb"]
    dry = "--dry" in sys.argv
    out = json.loads(OUT.read_text()) if OUT.exists() else {}
    for sport in sports:
        years = [2022, 2023, 2025] if sport == "cbb" else [2023, 2025]  # the seasons the closing-line files cover (start year of the season)
        pkl = Path(__file__).resolve().parents[1] / "data" / f"seed_replay_{sport}.pkl"
        df = pd.read_pickle(pkl) if pkl.exists() and "--refresh" not in sys.argv else replay(sport, years)
        df.to_pickle(pkl)
        df = add_tiers(add_day(df, sport))
        train, test = df[df.year < years[-1]], df[df.year >= years[-1]]
        report(train, test, sport, f"{sport}: fitted on the earlier seasons, checked on {years[-1]}")
        phases = fit_phases(df, sport)  # the file uses every season
        out[sport] = {"anchor": ANCHOR[sport], "phases": phases, "n": int(len(df)), "years": years}
    if not dry:
        OUT.write_text(json.dumps(out, indent=1))
        print("wrote", OUT)


if __name__ == "__main__":
    main()
