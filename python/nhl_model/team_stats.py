"""
Team and goalie tables for the site's NHL "Teams" and "Goalies" tabs.

Everything here is DESCRIPTIVE - what already happened, measured with our own xG - not a forecast.

Expected points: for every finished game, each team's regulation shots become a Poisson-binomial
distribution of goals (every unblocked attempt scores with probability = its SCORE-ADJUSTED xG, independently),
so we get P(team wins in regulation), P(tied after 60:00), P(loses in regulation) from the CHANCES alone.
Score adjustment (score_state_frame): a team protecting a lead is out-chanced and a trailing team pushes, which
makes raw single-game xG look worse for winners than it is. Each shot's xG is reweighted by the league-wide xG
rate in that score state, relative to a tied game. In testing (2015-2025) this took the "top-chances team wins"
calibration from 69% modelled / 47% actual to 70% / 61% and lifted a first-half -> second-half points test from
0.50 to 0.53 (real points: 0.57). The unadjusted version is kept as xpts_raw.
Standings points are 2 for a win, 1 for an overtime/shootout loss, 0 for a regulation loss, and a game
that is tied after 60:00 is an overtime/shootout coin flip (the winner gets 2, the loser 1), so
    xPts = 2 * P(win in reg) + 1.5 * P(tied after reg)
A team that out-chanced its opponent but lost 2-1 still earns most of those points here. The gap between
real points and xPts is "luck" (finishing, goaltending, empty nets, overtime coin flips).
Real games are more lopsided-or-tied than independent shots imply (goal counts are over-dispersed relative
to a Poisson-binomial of xG), which would make the raw model's tie rate ~17% against the real ~22%. So the
tie probability is rescaled by one league-wide factor so the model's tie rate matches reality, and wins and
losses share what's left in their original proportion. Empty-net goals are not in xG, so a team protecting a
lead is slightly under-credited.

Goalies: goals saved above expected (GSAx) = xG of the unblocked attempts a goalie faced minus the goals
that went in - the same quantity the simulator's goalie rating is built on (goalie_model.py).

Published to Supabase as one row per (season, scope, team|goalie) with a jsonb `stats` blob, so adding a
column to the table on the site doesn't need a migration. scope "all" = the whole season, "l10" = each
team's last 10 games (a goalie's last 10 appearances) in the CURRENT season only.

    python -m nhl_model.team_stats             # compute + publish
    python -m nhl_model.team_stats --dry-run   # compute, print, write data/nhl/team_stats.json
"""
from __future__ import annotations

import argparse
import json
import warnings

import numpy as np
import pandas as pd

from .goalie_model import build_tracker
from .ingest import DATA_DIR, RAW_PBP, read_gz
from . import power_rating
from .parse import GAMES_OUT
from .sim_backtest import GOALIE_PRIOR_ATTEMPTS
from .team_games import TEAM_GAMES_OUT
from .xg import SHOTS_XG_OUT

warnings.filterwarnings("ignore")

STATS_JSON = DATA_DIR / "team_stats.json"
GOALIE_NAMES_JSON = DATA_DIR / "goalie_names.json"
MAX_GOALS = 14  # a team scoring more than this in regulation is a rounding error
L10 = 10

TEAM_NAMES = {
    "ANA": "Anaheim Ducks", "ARI": "Arizona Coyotes", "ATL": "Atlanta Thrashers", "BOS": "Boston Bruins", "BUF": "Buffalo Sabres",
    "CAR": "Carolina Hurricanes", "CBJ": "Columbus Blue Jackets", "CGY": "Calgary Flames", "CHI": "Chicago Blackhawks",
    "COL": "Colorado Avalanche", "DAL": "Dallas Stars", "DET": "Detroit Red Wings", "EDM": "Edmonton Oilers", "FLA": "Florida Panthers",
    "LAK": "Los Angeles Kings", "MIN": "Minnesota Wild", "MTL": "Montreal Canadiens", "NJD": "New Jersey Devils",
    "NSH": "Nashville Predators", "NYI": "New York Islanders", "NYR": "New York Rangers", "OTT": "Ottawa Senators",
    "PHI": "Philadelphia Flyers", "PIT": "Pittsburgh Penguins", "SEA": "Seattle Kraken", "SJS": "San Jose Sharks",
    "STL": "St. Louis Blues", "TBL": "Tampa Bay Lightning", "TOR": "Toronto Maple Leafs", "UTA": "Utah Mammoth",
    "VAN": "Vancouver Canucks", "VGK": "Vegas Golden Knights", "WPG": "Winnipeg Jets", "WSH": "Washington Capitals",
}


def _r(x, d: int = 3):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), d)


def _div(a, b):
    return float(a) / float(b) if b else None


LEAD_CAP = 3  # score states are "own lead before the shot", capped at +-3


def score_state_frame() -> pd.DataFrame:
    """Every unblocked regulation attempt with the shooter's lead BEFORE the shot (own goals - opponent goals,
    capped at +-3) and its score-adjusted xG.

    Score effects: a team that is ahead plays safer and gets out-chanced, a team that is behind pushes. Over 13k
    games the average team creates about 3.1 xG per 60 minutes when trailing by two, 2.7 when tied and 2.5 when
    leading by two or more. Each shot's xG is weighted by (tied-game rate / rate in that score state), so a
    leader's chances count a little more and a trailer's a little less - roughly what the chances would have
    been if the score hadn't changed how anyone played."""
    s = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "period", "t", "event", "shooter_team_id", "xg", "sk_for", "sk_against"], low_memory=False)
    s = s[s["period"] <= 3].copy()
    s["order"] = np.arange(len(s))
    s = s.sort_values(["game_id", "t", "order"]).reset_index(drop=True)  # t is seconds from the start of the game
    goal = (s["event"] == "goal").astype(int)
    s["goal"] = goal
    own_before = s.groupby(["game_id", "shooter_team_id"])["goal"].cumsum() - s["goal"]
    all_before = s.groupby("game_id")["goal"].cumsum() - s["goal"]
    s["lead"] = (2 * own_before - all_before).clip(-LEAD_CAP, LEAD_CAP)

    # time spent in each state, from the goal times
    tg = pd.read_csv(TEAM_GAMES_OUT, usecols=["game_id", "team_id", "opp_id"]).drop_duplicates("game_id")
    goals = s[s["goal"] == 1].groupby("game_id")[["t", "shooter_team_id"]].apply(lambda d: list(zip(d["t"], d["shooter_team_id"])))
    seconds: dict[int, float] = {k: 0.0 for k in range(-LEAD_CAP, LEAD_CAP + 1)}
    for r in tg.itertuples():
        cur, last = 0, 0.0
        for c, team in goals.get(r.game_id, []):
            d = int(np.clip(cur, -LEAD_CAP, LEAD_CAP))
            seconds[d] += c - last  # team_id's seconds at lead d ...
            seconds[-d] += c - last  # ... and the opponent's at -d
            cur += 1 if team == r.team_id else -1
            last = c
        d = int(np.clip(cur, -LEAD_CAP, LEAD_CAP))
        seconds[d] += 3600.0 - last
        seconds[-d] += 3600.0 - last
    x = s[s["xg"].notna()]
    per_state = x.groupby("lead")["xg"].sum()
    rate = {k: per_state.get(k, 0.0) / seconds[k] for k in seconds if seconds[k] > 0}
    weight = {k: rate[0] / v for k, v in rate.items()}
    s["xg_adj"] = s["xg"] * s["lead"].map(weight)
    return s


# ---------------------------------------------------------------- expected points

def goals_pmf(xgs: np.ndarray) -> np.ndarray:
    """Distribution of the number of goals when attempt i scores with probability xgs[i]."""
    p = np.zeros(MAX_GOALS + 1)
    p[0] = 1.0
    for x in xgs:
        q = p * (1.0 - x)
        q[1:] += p[:-1] * x
        p = q
    return p


def result_probs(a: np.ndarray, b: np.ndarray) -> tuple[float, float, float]:
    """(P(a > b), P(a == b), P(a < b)) for two independent goal distributions."""
    cdf_b = np.cumsum(b)
    win = float(np.sum(a[1:] * cdf_b[:-1]))
    tie = float(np.sum(a * b))
    return win, tie, max(0.0, 1.0 - win - tie)


def _points(win: np.ndarray, tie: np.ndarray, loss: np.ndarray, real_tie_rate: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Rescale P(tied after 60) so the model's league-wide tie rate equals the real one (independent shots are less
    over-dispersed than real games), give wins and losses what's left in their original proportion, then convert to
    expected points and expected wins."""
    k = real_tie_rate / float(tie.mean())
    t = np.minimum(tie * k, 0.6)
    wl = np.where(win + loss > 0, win + loss, np.nan)
    w2, l2 = (1 - t) * win / wl, (1 - t) * loss / wl
    return w2, t, l2, 2.0 * w2 + 1.5 * t, w2 + 0.5 * t


def game_expectations() -> pd.DataFrame:
    """One row per (game, team): expected points two ways - from raw xG and from score-adjusted xG (the headline) -
    plus that team's score-adjusted regulation xG for and against."""
    s = score_state_frame()
    x = s[s["xg"].notna()]
    raw = {k: g["xg"].to_numpy() for k, g in x.groupby(["game_id", "shooter_team_id"])}
    adj = {k: np.clip(g["xg_adj"].to_numpy(), 0.0, 0.97) for k, g in x.groupby(["game_id", "shooter_team_id"])}
    tg = pd.read_csv(TEAM_GAMES_OUT, usecols=["game_id", "team_id", "opp_id", "goals_for_reg_official", "goals_against_reg_official"])
    cache: dict[tuple, np.ndarray] = {}

    def pm(src: dict, tag: str, key: tuple) -> np.ndarray:
        if (tag, key) not in cache:
            cache[(tag, key)] = goals_pmf(src.get(key, np.zeros(0)))
        return cache[(tag, key)]

    rows = []
    for r in tg.itertuples():
        ka, kb = (r.game_id, r.team_id), (r.game_id, r.opp_id)
        if ka not in raw and kb not in raw:
            continue
        rw, rt, rl = result_probs(pm(raw, "raw", ka), pm(raw, "raw", kb))
        aw, at, al = result_probs(pm(adj, "adj", ka), pm(adj, "adj", kb))
        rows.append((r.game_id, r.team_id, rw, rt, rl, aw, at, al, float(adj.get(ka, np.zeros(0)).sum()), float(adj.get(kb, np.zeros(0)).sum())))
    ex = pd.DataFrame(rows, columns=["game_id", "team_id", "rw", "rt", "rl", "aw", "at", "al", "xgf_adj", "xga_adj"])
    real = tg.set_index(["game_id", "team_id"])
    tie_rate = float((real["goals_for_reg_official"] == real["goals_against_reg_official"]).mean())
    pw, pt, pl, xpts, xw = _points(ex["aw"].to_numpy(), ex["at"].to_numpy(), ex["al"].to_numpy(), tie_rate)
    _, _, _, xpts_raw, _ = _points(ex["rw"].to_numpy(), ex["rt"].to_numpy(), ex["rl"].to_numpy(), tie_rate)
    ex["p_win_reg"], ex["p_tie_reg"], ex["p_loss_reg"], ex["xpts"], ex["xw"], ex["xpts_raw"] = pw, pt, pl, xpts, xw, xpts_raw

    # score-adjusted xG split into even strength vs power play / penalty kill, for the power rating
    even = x.assign(even=x["sk_for"] == x["sk_against"])
    split = even.groupby(["game_id", "shooter_team_id", "even"])["xg_adj"].sum().unstack(fill_value=0.0).reindex(columns=[False, True], fill_value=0.0)
    split.columns = ["st", "ev"]
    split = split.reset_index()
    own = split.rename(columns={"shooter_team_id": "team_id", "ev": "xgf_adj_ev", "st": "xgf_adj_st"})
    opp = split.rename(columns={"shooter_team_id": "opp_id", "ev": "xga_adj_ev", "st": "xga_adj_st"})
    ex = ex.merge(tg[["game_id", "team_id", "opp_id"]], on=["game_id", "team_id"], how="left")
    ex = ex.merge(own, on=["game_id", "team_id"], how="left").merge(opp, on=["game_id", "opp_id"], how="left")
    for c in ("xgf_adj_ev", "xgf_adj_st", "xga_adj_ev", "xga_adj_st"):
        ex[c] = ex[c].fillna(0.0)
    return ex.drop(columns=["rw", "rt", "rl", "aw", "at", "al", "opp_id"])


# ---------------------------------------------------------------- teams

def team_game_frame() -> pd.DataFrame:
    tg = pd.read_csv(TEAM_GAMES_OUT)
    tg["t"] = pd.to_datetime(tg["start_utc"], utc=True)
    ex = game_expectations()
    tg = tg.merge(ex, on=["game_id", "team_id"], how="left")
    won = tg["final_for"] > tg["final_against"]
    tg["w"] = won.astype(int)
    tg["otl"] = ((~won) & (tg["last_period"] != "REG")).astype(int)
    tg["l"] = ((~won) & (tg["last_period"] == "REG")).astype(int)
    tg["pts"] = 2 * tg["w"] + tg["otl"]
    tg["gf"] = tg["goals_reg"] + tg["goals_ot"]
    tg["ga"] = tg["goals_reg_against"] + tg["goals_ot_against"]
    tg["xgf"] = tg["xg_reg"] + tg["xg_ot"]
    tg["xga"] = tg["xg_reg_against"] + tg["xg_ot_against"]
    return tg


def team_stats(g: pd.DataFrame) -> dict:
    gp = len(g)
    c = lambda col: float(g[col].sum())  # noqa: E731
    have_x = g["xpts"].notna()
    xpts = float(g.loc[have_x, "xpts"].sum())
    pts_x = float(g.loc[have_x, "pts"].sum())  # real points over the same games, so the gap is apples to apples
    n_x = int(have_x.sum())
    xgf, xga = c("xgf"), c("xga")
    sa_f, sa_a = float(g.loc[have_x, "xgf_adj"].sum()), float(g.loc[have_x, "xga_adj"].sum())
    ev_f, ev_a = c("xg_reg_ev"), c("xg_reg_ev_against")
    return {
        "gp": gp, "w": int(c("w")), "l": int(c("l")), "otl": int(c("otl")), "pts": int(c("pts")),
        "pts_pct": _r(_div(c("pts"), 2 * gp), 4),
        "xpts": _r(xpts, 2), "pts_diff": _r(pts_x - xpts, 2), "xpts_gp": n_x,
        "xpts_pace": _r(_div(xpts, n_x) * 82, 1) if n_x else None,
        "xw": _r(float(g.loc[have_x, "xw"].sum()), 2),
        "xpts_raw": _r(float(g.loc[have_x, "xpts_raw"].sum()), 2),
        "sa_xgf_pct": _r(_div(sa_f, sa_f + sa_a), 4),  # regulation, score-adjusted
        "sa_xgd_pg": _r(_div(sa_f - sa_a, n_x)) if n_x else None,
        "gf_pg": _r(_div(c("gf"), gp)), "ga_pg": _r(_div(c("ga"), gp)),
        "xgf_pg": _r(_div(xgf, gp)), "xga_pg": _r(_div(xga, gp)), "xgd_pg": _r(_div(xgf - xga, gp)),
        "xgf_pct": _r(_div(xgf, xgf + xga), 4),
        "ev_xgf_pct": _r(_div(ev_f, ev_f + ev_a), 4),
        "cf_pct": _r(_div(c("corsi_for"), c("corsi_for") + c("corsi_against")), 4),
        "pp_xg60": _r(_div(c("xg_reg_pp") * 3600, c("sec_pp")), 2),
        "pk_xga60": _r(_div(c("xg_reg_pk_against") * 3600, c("sec_pk")), 2),
        "finishing_pg": _r(_div(c("gf") - xgf, gp)),  # goals scored above xG
        "goaltending_pg": _r(_div(xga - c("ga"), gp)),  # goals prevented vs xG (goalie + luck)
    }


def build_team_rows() -> list[dict]:
    tg = team_game_frame()
    games = pd.read_csv(GAMES_OUT, usecols=["start_utc", "home_team_id", "home_abbrev", "away_team_id", "away_abbrev"]).sort_values("start_utc")
    abbrev = {**dict(zip(games["away_team_id"], games["away_abbrev"])), **dict(zip(games["home_team_id"], games["home_abbrev"]))}
    latest = int(tg["season"].max())
    pr, _ = power_rating.rate(tg)
    power = {(int(r.season), int(r.team_id)): r for r in pr.itertuples()}
    rows = []
    for (season, team_id), g in tg.groupby(["season", "team_id"]):
        ab = abbrev.get(team_id, str(team_id))
        st = team_stats(g)
        pw = power.get((int(season), int(team_id)))
        if pw is not None:
            st["power"] = _r(pw.power)
            for f in power_rating.FEATURES:
                st[f"power_{f}"] = _r(getattr(pw, f"comp_{f}"))
            st["power_rel"] = _r(pw.rel, 2)
        rows.append({"season": int(season), "scope": "all", "team": ab, "team_id": int(team_id), "name": TEAM_NAMES.get(ab, ab), "stats": st})
        if season == latest:
            last = g.sort_values("t").tail(L10)
            rows.append({"season": int(season), "scope": "l10", "team": ab, "team_id": int(team_id), "name": TEAM_NAMES.get(ab, ab), "stats": team_stats(last)})
    return rows


# ---------------------------------------------------------------- goalies

def goalie_names(goalie_ids: set[int], games: pd.DataFrame) -> dict[int, str]:
    """id -> name. Cached on disk; only goalies we haven't named yet cost a play-by-play file read."""
    cache: dict[str, str] = json.loads(GOALIE_NAMES_JSON.read_text()) if GOALIE_NAMES_JSON.exists() else {}
    missing = [g for g in goalie_ids if str(g) not in cache]
    if missing:
        first_game = games.sort_values("game_id").drop_duplicates("goalie_id").set_index("goalie_id")
        wanted: dict[int, list[int]] = {}
        for g in missing:
            if g in first_game.index:
                r = first_game.loc[g]
                wanted.setdefault(int(r["game_id"]), []).append(g)
        for gid, ids in wanted.items():
            season = int(str(gid)[:4])
            path = RAW_PBP / str(season) / f"{gid}.json.gz"
            if not path.exists():
                continue
            for p in read_gz(path).get("rosterSpots", []):
                if p.get("positionCode") == "G" and str(p["playerId"]) not in cache:
                    cache[str(p["playerId"])] = f"{p['firstName']['default']} {p['lastName']['default']}"
        GOALIE_NAMES_JSON.write_text(json.dumps(cache))
    return {int(k): v for k, v in cache.items()}


def goalie_stats(g: pd.DataFrame, gp: int, gs: int) -> dict:
    att, xga, ga, sog = len(g), float(g["xg"].sum()), int(g["is_goal"].sum()), int(g["event"].isin(["shot-on-goal", "goal"]).sum())
    gsax = xga - ga
    return {
        "gp": gp, "gs": gs, "att": att, "sog": sog, "ga": ga, "xga": _r(xga, 2),
        "gsax": _r(gsax, 2), "gsax_per100": _r(_div(100 * gsax, att), 2), "gsax_pg": _r(_div(gsax, gp), 3),
        "ga_pg": _r(_div(ga, gp), 2), "xga_pg": _r(_div(xga, gp), 2), "sa_pg": _r(_div(sog, gp), 1),
        "sv_pct": _r(1 - ga / sog, 4) if sog else None,
        "xg_per_att": _r(_div(xga, att), 4),  # quality of what he faced: higher = harder chances
    }


def build_goalie_rows() -> list[dict]:
    s = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "season", "event", "goalie_id", "shooter_home", "xg", "is_goal"], low_memory=False)
    s = s[s["xg"].notna() & s["goalie_id"].notna()].copy()
    s["goalie_id"] = s["goalie_id"].astype(int)
    games = pd.read_csv(GAMES_OUT, usecols=["game_id", "start_utc", "home_team_id", "home_abbrev", "away_team_id", "away_abbrev", "home_goalie", "away_goalie"])
    games["t"] = pd.to_datetime(games["start_utc"], utc=True)
    s = s.merge(games[["game_id", "t", "home_abbrev", "away_abbrev"]], on="game_id", how="left")
    s["team"] = np.where(s["shooter_home"] == 1, s["away_abbrev"], s["home_abbrev"])  # the goalie's team is the shooter's opponent

    starters = pd.concat([
        games[["game_id", "home_goalie"]].rename(columns={"home_goalie": "goalie_id"}),
        games[["game_id", "away_goalie"]].rename(columns={"away_goalie": "goalie_id"}),
    ]).dropna()
    starters["goalie_id"] = starters["goalie_id"].astype(int)
    started = set(zip(starters["game_id"], starters["goalie_id"]))

    names = goalie_names(set(s["goalie_id"].unique()), s[["game_id", "goalie_id"]])
    tracker, _ = build_tracker(GOALIE_PRIOR_ATTEMPTS)
    now = s["t"].max()
    latest = int(s["season"].max())

    rows = []
    for (season, gid), g in s.groupby(["season", "goalie_id"]):
        team = g["team"].mode().iat[0]
        by_game = g.groupby("game_id")
        gp = by_game.ngroups
        gs = sum((gm, gid) in started for gm in by_game.groups)
        base = {"season": int(season), "goalie_id": int(gid), "name": names.get(int(gid), str(gid)), "team": team}
        st = goalie_stats(g, gp, gs)
        if season == latest:
            st["rating"] = _r(tracker.rating(gid, now), 2)  # what the simulator uses: decayed + shrunk GSAx per 100 attempts
        rows.append({**base, "scope": "all", "stats": st})
        if season == latest:
            last_games = g.groupby("game_id")["t"].first().sort_values().tail(L10).index
            gl = g[g["game_id"].isin(last_games)]
            rows.append({**base, "scope": "l10", "stats": goalie_stats(gl, len(last_games), sum((gm, gid) in started for gm in last_games))})
    return rows


# ---------------------------------------------------------------- publish

def upsert(client, table: str, rows: list[dict], conflict: str) -> None:
    now = pd.Timestamp.now(tz="UTC").isoformat()
    for i in range(0, len(rows), 300):
        client.table(table).upsert([{**r, "updated_at": now} for r in rows[i : i + 300]], on_conflict=conflict).execute()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    teams = build_team_rows()
    goalies = build_goalie_rows()
    latest = max(r["season"] for r in teams)
    cur = sorted((r for r in teams if r["season"] == latest and r["scope"] == "all"), key=lambda r: -(r["stats"]["xpts_pace"] or 0))
    print(f"{len(teams)} team rows, {len(goalies)} goalie rows (latest season {latest})")
    print(f"\n{'team':<5}{'GP':>4}{'Pts':>5}{'xPts':>7}{'diff':>7}{'xGF/g':>7}{'xGA/g':>7}{'xGF%':>7}")
    for r in cur[:10]:
        st = r["stats"]
        print(f"{r['team']:<5}{st['gp']:>4}{st['pts']:>5}{st['xpts'] or 0:>7.1f}{st['pts_diff'] or 0:>7.1f}{st['xgf_pg'] or 0:>7.2f}{st['xga_pg'] or 0:>7.2f}{(st['xgf_pct'] or 0) * 100:>7.1f}")
    top = sorted((r for r in goalies if r["season"] == latest and r["scope"] == "all" and r["stats"]["gp"] >= 3), key=lambda r: -r["stats"]["gsax"])[:8]
    print(f"\n{'goalie':<24}{'team':<5}{'GP':>4}{'GSAx':>7}{'/100':>7}{'Sv%':>8}")
    for r in top:
        st = r["stats"]
        print(f"{r['name']:<24}{r['team']:<5}{st['gp']:>4}{st['gsax']:>7.1f}{st['gsax_per100']:>7.2f}{(st['sv_pct'] or 0):>8.3f}")

    STATS_JSON.write_text(json.dumps({"teams": teams, "goalies": goalies}))
    if a.dry_run:
        print("\ndry run - nothing written to Supabase")
        return
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    try:
        upsert(client, "nhl_team_stats", teams, "season,scope,team")
        upsert(client, "nhl_goalie_stats", goalies, "season,scope,goalie_id")
    except Exception as e:  # noqa: BLE001
        if "PGRST205" in str(e) or "does not exist" in str(e) or "schema cache" in str(e):
            print("\nThe nhl_team_stats / nhl_goalie_stats tables don't exist yet - run the matching block in supabase/schema.sql first.")
            return
        raise
    print("\npublished to nhl_team_stats / nhl_goalie_stats")


if __name__ == "__main__":
    main()
