
"""
Inputs the strength-state simulation (sim.py) fits on and samples from:

  sim_team_games.csv.gz  one row per team-game: minutes and xG/goals at even
                         strength / power play / shorthanded, and penalties
                         taken / drawn (only ones that create a power play)
  sim_tables.json        league-level tables that don't depend on the
                         matchup:
      pen_duration   share of power-play-creating penalties that are minors
                     (2:00), double minors (4:00) and majors (5:00)
      late_game      what happens in the last 3:00 of regulation, by the
                     lead at 57:00 - the goalie-pulled / empty-net stretch.
                     An empirical table, NOT modeled from xG: pulled-goalie
                     hockey is a different game (and empty-net goals widen
                     one-goal games into two-goal ones, which is exactly what
                     decides puck lines and part of the total).
      overtime       P(a tied game is decided in 3v3 overtime vs the
                     shootout) and the home side's win rate in each

League tables use all history (they're structural - how teams pull goalies,
how long penalties last - not team strength), a small look-ahead the
backtest should be read with in mind.

Usage:
    python -m nhl_model.sim_inputs
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .parse import GAMES_OUT, PENS_OUT
from .team_games import TEAM_GAMES_OUT
from .xg import SHOTS_XG_OUT

SIM_TEAM_GAMES_OUT = DATA_DIR / "sim_team_games.csv.gz"
SIM_TABLES_OUT = DATA_DIR / "sim_tables.json"
LATE_SECONDS = 3420  # 57:00
PP_TYPES = {"MIN", "BEN", "MAJ"}


def build_team_games() -> pd.DataFrame:
    tg = pd.read_csv(TEAM_GAMES_OUT)
    pens = pd.read_csv(PENS_OUT)
    pens = pens[(pens["period"] <= 3) & pens["type_code"].isin(PP_TYPES) & pens["minutes"].isin([2, 4, 5])]
    taken = pens.groupby(["game_id", "team_id"]).size().rename("pens_taken").reset_index()
    tg = tg.merge(taken, on=["game_id", "team_id"], how="left")
    tg["pens_taken"] = tg["pens_taken"].fillna(0)
    drawn = tg[["game_id", "opp_id", "pens_taken"]].rename(columns={"opp_id": "team_id", "pens_taken": "pens_drawn"})
    tg = tg.merge(drawn, on=["game_id", "team_id"], how="left")

    tracked = tg["tracked_reg_seconds"].clip(lower=3000)
    tg["pp_min"] = tg["sec_pp"] / 60.0
    tg["pk_min"] = tg["sec_pk"] / 60.0
    tg["ev_min"] = ((tracked - tg["sec_pp"] - tg["sec_pk"]).clip(lower=1200)) / 60.0
    keep = [
        "game_id", "season", "start_utc", "team_id", "opp_id", "is_home", "goalie", "opp_goalie", "last_period",
        "final_for", "final_against", "goals_for_reg_official", "goals_against_reg_official",
        "ev_min", "pp_min", "pk_min", "pens_taken", "pens_drawn",
        "xg_reg", "goals_reg", "xg_reg_ev", "xg_reg_pp", "xg_reg_pk", "goals_reg_ev", "goals_reg_pp", "goals_reg_pk",
    ]
    return tg[keep]


def build_tables(games: pd.DataFrame) -> dict:
    pens = pd.read_csv(PENS_OUT)
    pens = pens[(pens["period"] <= 3) & pens["type_code"].isin(PP_TYPES) & pens["minutes"].isin([2, 4, 5])]
    dur = pens["minutes"].value_counts(normalize=True)
    tables: dict = {"pen_duration": {"minor": float(dur.get(2, 0)), "double": float(dur.get(4, 0)), "major": float(dur.get(5, 0))}}

    # last 3:00 of regulation, by lead at 57:00
    shots = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "period", "t", "is_goal", "shooter_team_id"], low_memory=False)
    goals = shots[(shots["is_goal"] == 1) & (shots["period"] <= 3)]
    g = games[["game_id", "home_team_id"]]
    goals = goals.merge(g, on="game_id")
    goals["home"] = (goals["shooter_team_id"] == goals["home_team_id"]).astype(int)
    goals["late"] = goals["t"] > LATE_SECONDS
    agg = goals.groupby(["game_id", "late", "home"]).size().unstack(["late", "home"], fill_value=0)
    agg.columns = [f"{'late' if late else 'early'}_{'h' if h else 'a'}" for late, h in agg.columns]
    agg = agg.reindex(games["game_id"], fill_value=0)
    for c in ("early_h", "early_a", "late_h", "late_a"):
        if c not in agg:
            agg[c] = 0
    lead = (agg["early_h"] - agg["early_a"]).to_numpy()
    late_table = {}
    for m in (0, 1, 2, 3):
        sel = (lead == 0) if m == 0 else (np.abs(lead) == m if m < 3 else np.abs(lead) >= 3)
        if m == 0:
            pairs = list(zip(agg["late_h"][sel], agg["late_a"][sel]))  # (home, away) when tied
        else:
            leader_home = lead[sel] > 0
            lh, la = agg["late_h"].to_numpy()[sel], agg["late_a"].to_numpy()[sel]
            pairs = list(zip(np.where(leader_home, lh, la), np.where(leader_home, la, lh)))  # (leader, trailer)
        cnt = pd.Series(pairs).value_counts(normalize=True)
        late_table[str(m)] = {"pairs": [list(map(int, k)) for k in cnt.index], "probs": [float(v) for v in cnt.values], "n": int(sel.sum())}
    tables["late_game"] = late_table

    # overtime / shootout, home perspective, among games tied after regulation
    t = games[games["last_period"].isin(["OT", "SO"])]
    home_won = t["final_home"] > t["final_away"]
    tables["overtime"] = {
        "p_decided_in_ot": float((t["last_period"] == "OT").mean()),
        "home_win_ot": float(home_won[t["last_period"] == "OT"].mean()),
        "home_win_so": float(home_won[t["last_period"] == "SO"].mean()),
        "n": int(len(t)),
    }
    return tables


def run() -> None:
    tg = build_team_games()
    tg.to_csv(SIM_TEAM_GAMES_OUT, index=False)
    games = pd.read_csv(GAMES_OUT)
    tables = build_tables(games)
    SIM_TABLES_OUT.write_text(json.dumps(tables))
    print(f"{len(tg):,} team-games -> {SIM_TEAM_GAMES_OUT}")
    print("penalty durations:", {k: round(v, 3) for k, v in tables["pen_duration"].items()})
    print("overtime:", {k: round(v, 3) if isinstance(v, float) else v for k, v in tables["overtime"].items()})
    for m, v in tables["late_game"].items():
        top = list(zip(v["pairs"][:4], [round(p, 3) for p in v["probs"][:4]]))
        print(f"late game, lead {m}{'+' if m == '3' else ''} (n={v['n']}): top outcomes (a,b)->p {top}")
    a = tg[["ev_min", "pp_min", "pk_min", "pens_taken", "pens_drawn"]].mean()
    print("per team-game means:", a.round(2).to_dict())


if __name__ == "__main__":
    run()
