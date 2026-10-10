"""
Does knowing the LINEUP help predict a game, beyond knowing the TEAM?

Two ways to say how strong a side is going into a game, both using only information from before it:

  team-only   the team's own recent 5v5 expected-goal differential per 60, over its previous ~40 games (exponentially
              decayed, carrying across seasons - this is what a team rating does, and it is blind to roster changes)
  lineup      the sum over the skaters who actually dressed of (his 5v5 net impact per 60 from the ratings fit on games
              BEFORE the test window) x (his usual 5v5 minutes per game) / 60 - so a team that added a star or lost one
              moves the day the roster does

The target is the game's realised 5v5 xG differential (home minus away). Ratings are refit at the start of each test window
and frozen through it, exactly as they would be in production. Coefficients are fitted leave-one-window-out. The windows
include the opening 6 weeks of each season, where roster moves matter most.

    python -m nhl_model.lineup_test
"""
from __future__ import annotations

import time
import warnings

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .player_ratings import STINTS_OUT, fit_rapm

warnings.filterwarnings("ignore")

LAMBDA = 25000.0
TEAM_HALF_LIFE_GAMES = 40.0
WINDOWS = [  # (label, start, days)
    ("2024-25 opening", "2024-10-04", 45),
    ("2024-25 mid", "2025-01-15", 60),
    ("2025-26 opening", "2025-10-07", 45),
    ("2025-26 mid", "2026-01-15", 60),
]


def main() -> None:
    t0 = time.time()
    st = pd.read_csv(STINTS_OUT)
    games = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc", "home_team_id", "away_team_id"]).set_index("game_id")
    games["t"] = pd.to_datetime(games["start_utc"], utc=True)
    game_dates = games["t"]

    hcols = [f"h{i}" for i in range(5)]
    acols = [f"a{i}" for i in range(5)]

    # per-game 5v5 totals: seconds and home-minus-away xG
    g = st.groupby("game_id").agg(dur=("dur", "sum"), xgd=("xg_home", "sum"), xga=("xg_away", "sum"))
    g["xgd"] = g["xgd"] - g["xga"]
    g = g.join(games[["t", "home_team_id", "away_team_id"]]).dropna().sort_values("t")

    # team-only rating before each game: decayed mean of the team's own 5v5 xGD per 60 over its previous games
    team_hist: dict[int, list[tuple[float, float]]] = {}  # team -> [(xgd per 60 for that team, weight seconds)]
    pre_home, pre_away = {}, {}
    for gid, r in g.iterrows():
        for side, team in (("h", int(r.home_team_id)), ("a", int(r.away_team_id))):
            h = team_hist.get(team, [])
            if h:
                w = np.array([0.5 ** ((len(h) - 1 - i) / TEAM_HALF_LIFE_GAMES) * s for i, (_, s) in enumerate(h)])
                v = np.array([x for x, _ in h])
                est = float((w * v).sum() / w.sum()) if w.sum() > 0 else 0.0
            else:
                est = 0.0
            (pre_home if side == "h" else pre_away)[gid] = est
        per60 = r.xgd / max(r.dur, 1.0) * 3600.0
        team_hist.setdefault(int(r.home_team_id), []).append((per60, r.dur))
        team_hist.setdefault(int(r.away_team_id), []).append((-per60, r.dur))
    g["team_diff"] = pd.Series(pre_home) - pd.Series(pre_away)  # per 60, home minus away

    # dressed skaters per game and side
    dressed_h = st[["game_id"] + hcols].melt(id_vars="game_id", value_name="pid")[["game_id", "pid"]].drop_duplicates()
    dressed_a = st[["game_id"] + acols].melt(id_vars="game_id", value_name="pid")[["game_id", "pid"]].drop_duplicates()
    long = pd.concat([st[["game_id", "dur", c]].rename(columns={c: "pid"}) for c in hcols + acols])

    rows = []
    for label, start, days in WINDOWS:
        cut = pd.Timestamp(start, tz="UTC")
        end = cut + pd.Timedelta(days=days)
        t1 = time.time()
        pids, off, de, icpt, ybar = fit_rapm(st, game_dates, LAMBDA, as_of=cut)
        net = pd.Series(off - de, index=pids.astype(int))

        before = long[game_dates.reindex(long["game_id"]).to_numpy() < cut]
        minutes = before.groupby("pid")["dur"].sum() / 60.0
        gp = before.groupby("pid")["game_id"].nunique()
        toi_pg = (minutes / gp).rename("toi")

        test_ids = g.index[(g["t"] >= cut) & (g["t"] < end)]
        dh = dressed_h[dressed_h["game_id"].isin(test_ids)].copy()
        da = dressed_a[dressed_a["game_id"].isin(test_ids)].copy()
        for d in (dh, da):
            d["value"] = d["pid"].map(net).fillna(0.0) * d["pid"].map(toi_pg).fillna(0.0) / 60.0  # xG per game vs average
        lh = dh.groupby("game_id")["value"].sum()
        la = da.groupby("game_id")["value"].sum()
        w = g.loc[test_ids].copy()
        w["lineup_diff"] = lh.reindex(w.index) - la.reindex(w.index)
        w["window"] = label
        rows.append(w.dropna(subset=["lineup_diff", "team_diff"]))
        print(f"{label}: fit + {len(w)} games in {time.time() - t1:.0f}s", flush=True)

    d = pd.concat(rows)
    d["y"] = d["xgd"]  # realised 5v5 xG differential (home minus away)
    d["team_x"] = d["team_diff"] * d["dur"] / 3600.0  # team-only prediction in xG for the minutes actually played
    d["lineup_x"] = d["lineup_diff"]  # already xG per game vs an average lineup (net x usual minutes / 60), home minus away
    print(f"\n{len(d)} test games.  sd of y {d['y'].std():.3f}\n")

    def ols(X, y):
        X1 = np.c_[np.ones(len(X)), X]
        b = np.linalg.lstsq(X1, y, rcond=None)[0]
        return b

    def r2(b, X, y):
        pred = np.c_[np.ones(len(X)), X] @ b
        return 1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum()

    print(f"{'window':<18}{'games':>6}{'corr team':>11}{'corr lineup':>13}{'R2 team':>10}{'R2 lineup':>11}{'R2 both':>9}")
    out = []
    for label in [w[0] for w in WINDOWS] + ["ALL"]:
        te = d if label == "ALL" else d[d["window"] == label]
        tr = d[d["window"] != label] if label != "ALL" else d
        y_te = te["y"].to_numpy()
        res = {}
        for name, cols in (("team", ["team_x"]), ("lineup", ["lineup_x"]), ("both", ["team_x", "lineup_x"])):
            b = ols(tr[cols].to_numpy(), tr["y"].to_numpy())
            res[name] = r2(b, te[cols].to_numpy(), y_te)
        print(
            f"{label:<18}{len(te):>6}{np.corrcoef(te['team_x'], y_te)[0, 1]:>11.3f}{np.corrcoef(te['lineup_x'], y_te)[0, 1]:>13.3f}"
            f"{res['team']:>10.4f}{res['lineup']:>11.4f}{res['both']:>9.4f}"
        )
        out.append((label, res))
    b = ols(d[["team_x", "lineup_x"]].to_numpy(), d["y"].to_numpy())
    print(f"\npooled fit: y = {b[0]:+.3f} + {b[1]:.3f} x team + {b[2]:.3f} x lineup   (1.0 would mean 'the rating is exactly right')")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
