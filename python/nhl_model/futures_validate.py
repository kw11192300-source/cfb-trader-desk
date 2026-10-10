"""
Does the season simulator's playoff probability mean what it says?

For each past season (2021-22 .. 2025-26) and two checkpoints (about 20 and 50 games in), play the REST of that season
from team ratings fitted only on games before the checkpoint, and compare each team's simulated chance to make the
playoffs / win its division against what happened. Reported as Brier score, log loss and a calibration table, for
several values of the team-strength uncertainty SIGMA - the one knob that decides how confident the odds look.

(Goalies are neutral in this test; the ratings at the checkpoint are the only information used.)

    python -m nhl_model.futures_validate
"""
from __future__ import annotations

import time
import warnings

import numpy as np
import pandas as pd

from .futures import DIVISIONS, GAME_SIMS, abbrev_by_id, game_outcomes, simulate_season, standings
from .ingest import SCHEDULE_CSV
from .sim import SimConfig, load_tables, simulate
from .sim_backtest import GOALIE_PRIOR_ATTEMPTS, fit_block, load_sim_team_games
from .goalie_model import build_tracker

warnings.filterwarnings("ignore")

ALIAS = {"ARI": "UTA"}  # Utah took Arizona's slot in the Central division
SEASONS = [2021, 2022, 2023, 2024, 2025]
CUT_DAYS = [45, 110]
SIGMAS = [0.0, 0.08, 0.14, 0.20, 0.28]
VAL_GAME_SIMS = 1200
VAL_SIMS = 3000


def actual_outcomes(season: int, ab: dict[int, str]) -> tuple[set[str], set[str]]:
    """(playoff teams, division winners) from the final regular-season standings, same rules the simulator uses."""
    st = standings(season)
    st.index = [ALIAS.get(ab.get(i, ""), ab.get(i, "")) for i in st.index]
    st = st[st.index.isin(DIVISIONS)]
    key = st["pts"] * 1e6 + st["rw"] * 1e3 + st["row"] + st["gd"] * 1e-3
    playoffs, winners = set(), set()
    for conf in ("East", "West"):
        members = [t for t in st.index if DIVISIONS[t][0] == conf]
        taken = []
        for div in sorted({DIVISIONS[t][1] for t in members}):
            ms = sorted((t for t in members if DIVISIONS[t][1] == div), key=lambda t: -key[t])
            winners.add(ms[0])
            taken += ms[:3]
        rest = sorted((t for t in members if t not in taken), key=lambda t: -key[t])
        playoffs |= set(taken) | set(rest[:2])
    return playoffs, winners


def main() -> None:
    t0 = time.time()
    ab = {k: ALIAS.get(v, v) for k, v in abbrev_by_id().items()}
    ids = {v: k for k, v in ab.items()}
    teams = sorted(DIVISIONS)
    tb = load_tables()
    _, gr = build_tracker(GOALIE_PRIOR_ATTEMPTS)
    tg = load_sim_team_games(gr)
    sched = pd.read_csv(SCHEDULE_CSV)
    sched["t"] = pd.to_datetime(sched["start_utc"], utc=True)
    sched["home_abbrev"] = sched["home_abbrev"].replace(ALIAS)
    sched["away_abbrev"] = sched["away_abbrev"].replace(ALIAS)

    records = []  # (sigma, season, cut, team, p_playoff, p_div, made, won)
    for season in SEASONS:
        s = sched[sched["season"] == season]
        if len(s) < 1200:
            continue
        playoffs, winners = actual_outcomes(season, ab)
        start = s["t"].min()
        for day in CUT_DAYS:
            cut = start + pd.Timedelta(days=day)
            fit = fit_block(tg, cut, SimConfig(use_goalie=True), tb)
            if fit is None:
                continue
            st = standings(season, as_of=cut)
            st.index = [ab.get(i, str(i)) for i in st.index]
            st = st[st.index.isin(DIVISIONS)]
            rem = s[s["t"] >= cut]
            games = []
            for k, r in enumerate(rem.itertuples()):
                h, a = r.home_abbrev, r.away_abbrev
                if h in DIVISIONS and a in DIVISIONS:
                    games.append((h, a, game_outcomes(fit, tb, simulate, int(ids[h]), int(ids[a]), 0.0, 0.0, VAL_GAME_SIMS, 7 + k)))
            P = np.zeros((len(teams), len(teams)))
            for i, h in enumerate(teams):
                for j, a in enumerate(teams):
                    if i != j:
                        P[i, j] = game_outcomes(fit, tb, simulate, int(ids[h]), int(ids[a]), 0.0, 0.0, 800, 90_000 + i * 40 + j)[:3].sum()
            for sigma in SIGMAS:
                res = simulate_season(teams, st, games, P, n_sims=VAL_SIMS, sigma=sigma, seed=3)
                for i, t in enumerate(teams):
                    records.append((sigma, season, day, t, float(res["playoffs"][i]), float(res["division"][i]), int(t in playoffs), int(t in winners)))
            print(f"{season} day {day}: {len(games)} games left, done at {time.time() - t0:.0f}s", flush=True)

    d = pd.DataFrame(records, columns=["sigma", "season", "day", "team", "p_po", "p_div", "made", "won"])
    d.to_csv("data/nhl/futures_validation.csv", index=False)

    def brier(p, y):
        return float(np.mean((p - y) ** 2))

    def logloss(p, y):
        p = np.clip(p, 1e-4, 1 - 1e-4)
        return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))

    print(f"\n{'sigma':>6}{'Brier po':>10}{'LL po':>8}{'Brier div':>11}{'LL div':>8}   (lower is better; {len(d[d.sigma == SIGMAS[0]])} team-checkpoints)")
    for sg in SIGMAS:
        g = d[d["sigma"] == sg]
        print(f"{sg:>6.2f}{brier(g.p_po, g.made):>10.4f}{logloss(g.p_po, g.made):>8.4f}{brier(g.p_div, g.won):>11.4f}{logloss(g.p_div, g.won):>8.4f}")

    best = min(SIGMAS, key=lambda sg: logloss(d[d.sigma == sg].p_po, d[d.sigma == sg].made) + logloss(d[d.sigma == sg].p_div, d[d.sigma == sg].won))
    print(f"\nbest sigma by combined log loss: {best}")
    g = d[d["sigma"] == best].copy()
    for label, pc, yc in (("make playoffs", "p_po", "made"), ("win division", "p_div", "won")):
        g["bin"] = pd.cut(g[pc], [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95, 1.0], include_lowest=True)
        t = g.groupby("bin", observed=True).agg(n=(yc, "size"), predicted=(pc, "mean"), actual=(yc, "mean"))
        print(f"\ncalibration - {label} (sigma {best}):")
        print(t.round(3).to_string())


if __name__ == "__main__":
    main()
