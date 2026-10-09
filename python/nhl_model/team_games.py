"""
Collapses games.csv.gz + shots_xg.csv.gz into one row per TEAM per game -
the table team ratings are fit on and the table the site's "xG for every
completed game" view reads from.

Per team-game: goals and xG for/against in regulation (periods 1-3, the
60-minute basis ratings use - overtime is 3v3 sudden death and a different
sport), split even strength / power play / penalty kill from THAT team's
point of view, plus raw shot-attempt counts and time on the power play /
penalty kill. Overtime xG is kept separately (`xg_ot_*`) so the game card can
show the full picture.

Strength-state definitions (shooter's skaters vs the other side's):
  ev  equal skaters (5v5, 4v4, 3v3) - 3v3 only exists in overtime
  pp  more skaters than the opponent while BOTH goalies are in
  pk  fewer skaters
  Empty-net situations (a goalie pulled) are dropped from xG entirely - see xg.py.

Usage:
    python -m nhl_model.team_games
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .parse import GAMES_OUT
from .xg import SHOTS_XG_OUT

TEAM_GAMES_OUT = DATA_DIR / "team_games.csv.gz"


def build() -> pd.DataFrame:
    games = pd.read_csv(GAMES_OUT)
    shots = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "period", "event", "shooter_team_id", "sk_for", "sk_against", "opp_goalie_in", "is_goal", "xg"])
    shots["state"] = np.where(shots["sk_for"] > shots["sk_against"], "pp", np.where(shots["sk_for"] < shots["sk_against"], "pk", "ev"))
    shots["phase"] = np.where(shots["period"] <= 3, "reg", "ot")
    unblocked = shots["event"].isin(["shot-on-goal", "missed-shot", "goal"])
    live_net = shots["opp_goalie_in"] == 1

    # xG and goals (empty-net goals excluded from both so xG-vs-goals compares like with like)
    x = shots[unblocked & live_net & shots["xg"].notna()]
    agg = x.groupby(["game_id", "shooter_team_id", "phase", "state"]).agg(xg=("xg", "sum"), goals=("is_goal", "sum")).reset_index()
    wide = agg.pivot_table(index=["game_id", "shooter_team_id"], columns=["phase", "state"], values=["xg", "goals"], fill_value=0.0)
    wide.columns = [f"{m}_{ph}_{st}" for m, ph, st in wide.columns]
    wide = wide.reset_index().rename(columns={"shooter_team_id": "team_id"})
    for m in ("xg", "goals"):
        for ph in ("reg", "ot"):
            for st in ("ev", "pp", "pk"):
                col = f"{m}_{ph}_{st}"
                if col not in wide:
                    wide[col] = 0.0
    for m in ("xg", "goals"):
        wide[f"{m}_reg"] = wide[f"{m}_reg_ev"] + wide[f"{m}_reg_pp"] + wide[f"{m}_reg_pk"]
        wide[f"{m}_ot"] = wide[f"{m}_ot_ev"] + wide[f"{m}_ot_pp"] + wide[f"{m}_ot_pk"]

    # raw regulation attempts (Corsi includes blocks; blocked attempts have the BLOCKER as owner upstream, already fixed in parse)
    reg = shots[shots["phase"] == "reg"]
    att = reg.groupby(["game_id", "shooter_team_id"]).agg(corsi_for=("event", "size")).reset_index().rename(columns={"shooter_team_id": "team_id"})
    sog = reg[reg["event"].isin(["shot-on-goal", "goal"])].groupby(["game_id", "shooter_team_id"]).size().rename("sog_for").reset_index().rename(columns={"shooter_team_id": "team_id"})

    rows = []
    for side, opp in (("home", "away"), ("away", "home")):
        t = games[["game_id", "season", "start_utc", f"{side}_team_id", f"{opp}_team_id", f"reg_{side}", f"reg_{opp}", f"final_{side}", f"final_{opp}",
                   "last_period", f"{side}_goalie", f"{opp}_goalie", "tracked_reg_seconds"]].copy()
        t.columns = ["game_id", "season_id", "start_utc", "team_id", "opp_id", "goals_for_reg_official", "goals_against_reg_official", "final_for", "final_against",
                     "last_period", "goalie", "opp_goalie", "tracked_reg_seconds"]
        t["is_home"] = 1 if side == "home" else 0
        t["sec_pp"] = games["sec_home_pp" if side == "home" else "sec_away_pp"].fillna(0).values
        t["sec_pk"] = games["sec_away_pp" if side == "home" else "sec_home_pp"].fillna(0).values
        rows.append(t)
    tg = pd.concat(rows, ignore_index=True)
    tg["season"] = tg["season_id"] // 10000
    tg = tg.merge(wide, on=["game_id", "team_id"], how="left").merge(att, on=["game_id", "team_id"], how="left").merge(sog, on=["game_id", "team_id"], how="left")
    # against = the opponent's "for"
    opp_cols = [c for c in wide.columns if c not in ("game_id", "team_id")] + ["corsi_for", "sog_for"]
    opp = tg[["game_id", "team_id"] + opp_cols].rename(columns={"team_id": "opp_id", **{c: c.replace("_for", "") + "_against" if c.endswith("_for") else c + "_against" for c in opp_cols}})
    tg = tg.merge(opp, on=["game_id", "opp_id"], how="left")
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    return tg.sort_values(["start_utc", "game_id", "is_home"], ascending=[True, True, False]).reset_index(drop=True)


def run() -> None:
    tg = build()
    tg.to_csv(TEAM_GAMES_OUT, index=False)
    print(f"{len(tg):,} team-games -> {TEAM_GAMES_OUT}")
    # sanity: xG vs goals per season, and regulation goals vs the official score
    g = tg.groupby("season").agg(games=("game_id", "size"), goals=("goals_reg", "sum"), xg=("xg_reg", "sum"), official=("goals_for_reg_official", "sum"))
    g["xg_per_team_game"] = g["xg"] / g["games"]
    print(g.round(1).to_string())


if __name__ == "__main__":
    run()
