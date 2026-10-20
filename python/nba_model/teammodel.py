"""
The bottom-up game model: team strength built from the players who will actually be on the floor.

For a game, each team's offence and defence rating is the minutes-weighted sum of its players' ratings (rapm.py):
    off_team = sum_i (minutes_i / 48) * off_i          def_team = sum_i (minutes_i / 48) * def_i        (minutes scaled to total 240)
so an injury changes the number twice: the player's rating leaves the sum, and his minutes go to the next men up (minutes.py).
Expected points per 100 possessions for the home team = league level + home court + off_home + def_away (def = points allowed).
Pace comes from the two teams' recent possession rates; margin and total follow.

Backtest: for each test season the ratings are fit on PRIOR seasons only and minutes are forecast by a model that never saw the
season; the game's actual availability is used (i.e. "if we knew who plays"), which is what the injury report gives us close to
tip. The result is compared with the opening and closing lines.

    python -m nba_model.teammodel evaluate
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .minutes import FEATURES_OUT
from .parse import GAMES_OUT, ODDS_OUT
from .props import minutes_forecasts
from .rapm import fit_rapm, load_stints, season_weights, two_stage


def ratings_as_of(last_season: int, lam: float = 5000.0, half_life: float = 4.0) -> pd.DataFrame:
    """Player off/def ratings from stints through `last_season` only."""
    st = load_stints(first=2021, last=last_season)
    sw = season_weights(sorted(st["season"].unique()), last_season, half_life)
    pids, off1, de1, mu, hca, on, box, p_off, p_def, ok = two_stage(st, sw)
    po, pdf = p_off - p_off.mean(), p_def - p_def.mean()
    o, d, *_ = fit_rapm(st, pids, lam, sw, prior_off=po, prior_def=pdf)
    return pd.DataFrame({"player_id": pids.astype("int64"), "off": o, "def": d, "poss": on})


def team_ratings(rows: pd.DataFrame, rat: pd.DataFrame, minutes_col: str = "pm_mean") -> pd.DataFrame:
    """One row per (event, team): minutes-weighted off / def of the players on the floor."""
    r = rows.merge(rat[["player_id", "off", "def"]], on="player_id", how="left").fillna({"off": 0.0, "def": 0.0})
    tot = r.groupby(["event_id", "team_id"])[minutes_col].transform("sum")
    r["w"] = r[minutes_col] / tot * 5.0  # share of the five player slots (sums to 5)
    g = r.assign(o=r["off"] * r["w"], d=r["def"] * r["w"]).groupby(["event_id", "team_id"]).agg(off=("o", "sum"), de=("d", "sum"), minutes=(minutes_col, "sum")).reset_index()
    return g


def evaluate() -> None:
    feats = pd.read_csv(FEATURES_OUT)
    gm = pd.read_csv(GAMES_OUT)
    gm["start_utc"] = pd.to_datetime(gm["start_utc"], utc=True)
    od = pd.read_csv(ODDS_OUT)
    played = feats[feats["played"] == 1].copy()
    out = []
    for season in (2022, 2023, 2024, 2025):
        print(f"== season {season}: ratings from seasons < {season}", flush=True)
        rat = ratings_as_of(season - 1)
        fc = minutes_forecasts(feats[feats["season"].isin([s for s in range(2021, 2026)])], holdout=season)
        pl = played[played["season"] == season].join(fc)
        pl = pl.dropna(subset=["pm_mean"])
        tr = team_ratings(pl, rat)
        h = tr.merge(gm[["event_id", "home_id"]], on="event_id")
        h = h[h["team_id"] == h["home_id"]][["event_id", "off", "de"]].rename(columns={"off": "off_h", "de": "de_h"})
        a = tr.merge(gm[["event_id", "away_id"]], on="event_id")
        a = a[a["team_id"] == a["away_id"]][["event_id", "off", "de"]].rename(columns={"off": "off_a", "de": "de_a"})
        g = gm[gm["season"] == season].merge(h, on="event_id").merge(a, on="event_id")
        g = g.merge(od[["event_id", "spread_home_open", "spread_home_close", "total_open", "total_close"]], on="event_id", how="left")
        out.append(g)
    G = pd.concat(out, ignore_index=True)
    G["margin"] = G["home_pts"] - G["away_pts"]
    G["total"] = G["home_pts"] + G["away_pts"]
    # per-100 expectation for the home side minus the away side; points = x pace/100
    G["m100"] = (G["off_h"] - G["off_a"]) + (G["de_a"] - G["de_h"])
    G["pace_pred"] = G.groupby("season")["pace"].transform("mean")  # league pace; refined below
    G["m_pts"] = G["m100"] * G["pace_pred"] / 100.0
    print(f"\n{len(G):,} test games, seasons {sorted(G.season.unique())}")
    for s, g in G.groupby("season"):
        c = np.corrcoef(g["m_pts"], g["margin"])[0, 1]
        sl = np.polyfit(g["m_pts"], g["margin"], 1)
        print(f"  {s}: corr(bottom-up margin, actual margin) {c:.3f} | actual = {sl[1]:+.2f} + {sl[0]:.2f} x model | model sd {g.m_pts.std():.2f}")
    # market comparison on lined games
    L = G.dropna(subset=["spread_home_close", "spread_home_open"]).copy()
    L["mk_close"], L["mk_open"] = -L["spread_home_close"], -L["spread_home_open"]
    print(f"\nlined games: {len(L):,}")
    for s, g in L.groupby("season"):
        sl = np.polyfit(g["m_pts"], g["margin"], 1)
        hca = (g["margin"] - sl[0] * g["m_pts"]).mean()
        print(f"  {s}: corr model-vs-close {np.corrcoef(g.m_pts, g.mk_close)[0, 1]:.3f} | model MAE {np.mean(np.abs(g.margin - (sl[0] * g.m_pts + hca))):.2f} | close MAE {np.mean(np.abs(g.margin - g.mk_close)):.2f} | open MAE {np.mean(np.abs(g.margin - g.mk_open)):.2f}")
    G.to_pickle(DATA_DIR / "teammodel_eval.pkl")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate"])
    ap.parse_args()
    evaluate()


if __name__ == "__main__":
    main()
