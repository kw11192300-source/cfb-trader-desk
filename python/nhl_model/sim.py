"""
Strength-state Monte Carlo of one NHL game.

Why a simulation instead of baseline.py's independent Poissons: the things
that decide totals, puck lines and the score grid are structural - power
plays arrive at random and end when they score, trailing teams pull the
goalie - and they make scores more dispersed (and margins wider) than two
independent Poisson counts. Both showed up as miscalibration in the
baseline (home -1.5 hit 33% against a predicted 30%, overs ran hot).

One simulated game:

  minutes 0-57  (3420 seconds)
    1. each team draws a Poisson number of power-play opportunities
       (team-specific: how often it draws vs how often the opponent takes
       penalties); each is a minor (2:00, ends the moment the power play
       scores), a double minor (two back-to-back minors) or a major (5:00,
       doesn't end on a goal), shares from history
    2. while on the power play a team scores at its power-play xG rate
       (vs that opponent's penalty kill); the short-handed team scores at a
       league short-handed rate
    3. the rest of the time is even strength, goals Poisson at each team's
       even-strength xG rate against the other's defense
  minutes 57-60: an EMPIRICAL table conditioned on the lead (empty-net goals
       and trailing-team goals) - see sim_inputs.py
  tied after 60: overtime (3v3 sudden death) or shootout, with the home
       side's historical win rates in each; the winner is credited one goal
       on the official final score (what US books settle totals and puck
       lines on)

Chances (xG) become goals through `conv` x the opposing goalie's multiplier:
exp(beta * (goalie rating - average)), same stage-2 construction as
goalie_model.py. conv/beta are fit on the training window's realized xG ->
goals.

Team ratings are Poisson ridge fits like baseline.py's, but on RATES per
minute in each state (exposure = minutes, via sample weights), with a prior
measured in effective games. Everything uses only games before the
prediction date.
"""
from __future__ import annotations

import json
import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.linear_model import PoissonRegressor

from .ingest import DATA_DIR
from .sim_inputs import SIM_TABLES_OUT

warnings.filterwarnings("ignore", message="Unknown solver options")
warnings.filterwarnings("ignore", category=DeprecationWarning)

REG_SECONDS_SIM = 3420  # 57:00 - the last 3:00 comes from the empirical table
MAX_PEN = 9


@dataclass
class SimConfig:
    half_life_days: float = 300.0
    level_half_life_days: float = 120.0
    lookback_days: int = 1100
    prior_games_ev: float = 10.0
    prior_games_pp: float = 40.0
    prior_games_pen: float = 25.0
    pp_opps_scale: float = 1.0  # starting point only - fit_block calibrates it per block so simulated power-play minutes match the data
    use_goalie: bool = True


@dataclass
class RateModel:
    teams: dict[int, int]
    mu: float
    home: float
    att: np.ndarray
    dfn: np.ndarray

    def rate(self, team: int, opp: int, is_home: bool) -> float:
        i, j = self.teams.get(team), self.teams.get(opp)
        a = self.att[i] if i is not None else 0.0
        d = self.dfn[j] if j is not None else 0.0
        return float(np.exp(self.mu + (self.home if is_home else 0.0) + a + d))


def fit_rate_model(train: pd.DataFrame, y_col: str, expo_col: str | None, as_of: pd.Timestamp, half_life: float, prior_games: float, min_expo: float = 0.3) -> RateModel:
    """Poisson ridge on rates: y = count/exposure with weight exposure*decay.
    Prior strength = `prior_games` average games' worth of exposure per rating."""
    d = train if expo_col is None else train[train[expo_col] >= min_expo]
    expo = np.ones(len(d)) if expo_col is None else d[expo_col].to_numpy()
    y = d[y_col].to_numpy() / expo
    age = (as_of - d["start_utc"]).dt.total_seconds().to_numpy() / 86400.0
    w = expo * np.exp(-np.log(2) * age / half_life)
    teams = {t: i for i, t in enumerate(sorted(set(d["team_id"]) | set(d["opp_id"])))}
    n = len(teams)
    X = np.zeros((len(d), 1 + 2 * n))
    X[:, 0] = d["is_home"].to_numpy()
    X[np.arange(len(d)), 1 + d["team_id"].map(teams).to_numpy()] = 1.0
    X[np.arange(len(d)), 1 + n + d["opp_id"].map(teams).to_numpy()] = 1.0
    mu_bar = float(np.average(y, weights=w))
    prior_expo = prior_games * float(expo.mean())
    alpha = mu_bar * prior_expo / w.sum()
    m = PoissonRegressor(alpha=alpha, max_iter=500, tol=1e-6).fit(X, y, sample_weight=w)
    att, dfn = m.coef_[1 : 1 + n], m.coef_[1 + n :]
    return RateModel(teams, float(m.intercept_ + att.mean() + dfn.mean()), float(m.coef_[0]), att - att.mean(), dfn - dfn.mean())


@dataclass
class Tables:
    pen_minor: float
    pen_double: float
    pen_major: float
    late: dict[int, tuple[np.ndarray, np.ndarray]] = field(default_factory=dict)  # lead -> (pairs (K,2), cumulative probs)
    p_ot: float = 0.664
    home_ot: float = 0.51
    home_so: float = 0.516


def load_tables() -> Tables:
    t = json.loads(SIM_TABLES_OUT.read_text())
    out = Tables(t["pen_duration"]["minor"], t["pen_duration"]["double"], t["pen_duration"]["major"],
                 p_ot=t["overtime"]["p_decided_in_ot"], home_ot=t["overtime"]["home_win_ot"], home_so=t["overtime"]["home_win_so"])
    for m, v in t["late_game"].items():
        probs = np.array(v["probs"])
        out.late[int(m)] = (np.array(v["pairs"]), np.cumsum(probs / probs.sum()))
    return out


@dataclass
class GameParams:
    """Everything the simulation needs for ONE matchup."""
    r_ev_h: float   # xG per minute, even strength
    r_ev_a: float
    r_pp_h: float   # xG per minute while on the power play
    r_pp_a: float
    pens_h: float   # expected power plays DRAWN by home in a full game
    pens_a: float
    r_sh: float     # xG per minute while shorthanded (league)
    conv_h: float   # xG -> goals multiplier for HOME scoring (conv x opposing goalie)
    conv_a: float


def _pp_block(rng: np.random.Generator, n: int, lam: float, rate_sec: float, tb: Tables) -> tuple[np.ndarray, np.ndarray]:
    """One team's power plays across minutes 0-57: (seconds on the PP, PP goals) per simulated game."""
    cnt = np.minimum(rng.poisson(lam * REG_SECONDS_SIM / 3600.0, n), MAX_PEN)
    active = np.arange(MAX_PEN)[None, :] < cnt[:, None]
    u = rng.random((n, MAX_PEN))
    major = u < tb.pen_major
    double = (~major) & (u < tb.pen_major + tb.pen_double)
    length = np.zeros(n)
    goals = np.zeros(n)
    for j in range(2):  # a double minor is two back-to-back minors
        seg = active & ~major & (double if j == 1 else True)
        t_goal = rng.exponential(1.0 / max(rate_sec, 1e-9), (n, MAX_PEN))
        length += (seg * np.minimum(120.0, t_goal)).sum(1)
        goals += (seg & (t_goal < 120.0)).sum(1)
    mj = active & major
    length += mj.sum(1) * 300.0
    goals += (rng.poisson(rate_sec * 300.0, (n, MAX_PEN)) * mj).sum(1)
    return length, goals


def _late(rng: np.random.Generator, lead: np.ndarray, tb: Tables) -> tuple[np.ndarray, np.ndarray]:
    """Goals in the last 3:00 for (home, away), sampled from the empirical table for each game's lead."""
    n = lead.size
    gh, ga = np.zeros(n, dtype=int), np.zeros(n, dtype=int)
    for m in (0, 1, 2, 3):
        sel = (lead == 0) if m == 0 else ((np.abs(lead) == m) if m < 3 else (np.abs(lead) >= 3))
        k = int(sel.sum())
        if not k:
            continue
        pairs, cum = tb.late[m]
        draw = pairs[np.minimum(np.searchsorted(cum, rng.random(k)), len(pairs) - 1)]
        if m == 0:
            gh[sel], ga[sel] = draw[:, 0], draw[:, 1]
        else:
            home_leads = lead[sel] > 0
            gh[sel] = np.where(home_leads, draw[:, 0], draw[:, 1])
            ga[sel] = np.where(home_leads, draw[:, 1], draw[:, 0])
    return gh, ga


def simulate(p: GameParams, tb: Tables, n: int = 20000, seed: int = 0) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    # chances -> goals per second for each state
    pp_h_sec = p.r_pp_h * p.conv_h / 60.0
    pp_a_sec = p.r_pp_a * p.conv_a / 60.0
    len_h, g_pp_h = _pp_block(rng, n, p.pens_h, pp_h_sec, tb)   # home power plays (away shorthanded)
    len_a, g_pp_a = _pp_block(rng, n, p.pens_a, pp_a_sec, tb)   # away power plays (home shorthanded)
    sh_h = rng.poisson(p.r_sh * p.conv_h / 60.0 * len_a)         # home goals while shorthanded
    sh_a = rng.poisson(p.r_sh * p.conv_a / 60.0 * len_h)
    ev_sec = np.maximum(REG_SECONDS_SIM - len_h - len_a, 300.0)
    ev_h = rng.poisson(p.r_ev_h * p.conv_h / 60.0 * ev_sec)
    ev_a = rng.poisson(p.r_ev_a * p.conv_a / 60.0 * ev_sec)
    h57 = (ev_h + g_pp_h + sh_h).astype(int)
    a57 = (ev_a + g_pp_a + sh_a).astype(int)
    lh, la = _late(rng, h57 - a57, tb)
    reg_h, reg_a = h57 + lh, a57 + la

    tie = reg_h == reg_a
    decided_ot = rng.random(n) < tb.p_ot
    home_win_p = np.where(decided_ot, tb.home_ot, tb.home_so)
    home_wins_extra = rng.random(n) < home_win_p
    fin_h = reg_h + (tie & home_wins_extra)
    fin_a = reg_a + (tie & ~home_wins_extra)
    # through overtime, EXCLUDING the shootout credit (60-min-plus-OT variant some markets use)
    ot_h = reg_h + (tie & decided_ot & home_wins_extra)
    ot_a = reg_a + (tie & decided_ot & ~home_wins_extra)
    return {"h57": h57, "a57": a57, "reg_h": reg_h, "reg_a": reg_a, "fin_h": fin_h, "fin_a": fin_a, "ot_h": ot_h, "ot_a": ot_a, "tie": tie, "so": tie & ~decided_ot,
            "pp_len_h": len_h, "pp_len_a": len_a}


def summarize_sim(s: dict[str, np.ndarray], with_grids: bool = False) -> dict:
    """All the market probabilities from one set of sims."""
    fin_total = s["fin_h"] + s["fin_a"]
    reg_total = s["reg_h"] + s["reg_a"]
    ot_total = s["ot_h"] + s["ot_a"]
    margin = s["fin_h"] - s["fin_a"]
    reg_margin = s["reg_h"] - s["reg_a"]
    n = fin_total.size
    out = {
        "p_home": float((margin > 0).mean()),
        "p_home_reg": float((reg_margin > 0).mean()),
        "p_tie_reg": float(s["tie"].mean()),
        "p_shootout": float(s["so"].mean()),
        "exp_home": float(s["fin_h"].mean()),
        "exp_away": float(s["fin_a"].mean()),
        "exp_total_final": float(fin_total.mean()),
        "exp_total_reg": float(reg_total.mean()),
        "exp_pp_min_h": float(s["pp_len_h"].mean() / 60.0),
        "exp_pp_min_a": float(s["pp_len_a"].mean() / 60.0),
    }
    for k in range(0, 17):
        out[f"pt_{k}"] = float((fin_total == k).mean())       # final-score total (incl. shootout credit)
        out[f"pr_{k}"] = float((reg_total == k).mean())       # regulation total
        out[f"po_{k}"] = float((ot_total == k).mean())        # through overtime, no shootout credit
    for k in range(-8, 9):
        out[f"pm_{k}"] = float((margin == k).mean())          # final home margin
    if with_grids:
        # joint score grids, home 0..9 x away 0..9: `sc_` = official FINAL score (a shootout
        # win is credited one goal, so a tie never appears), `rc_` = regulation (60:00)
        for prefix, hh, aa in (("sc", s["fin_h"], s["fin_a"]), ("rc", s["reg_h"], s["reg_a"])):
            joint = np.bincount(np.clip(hh, 0, 9) * 10 + np.clip(aa, 0, 9), minlength=100) / n
            for i in range(100):
                out[f"{prefix}_{i // 10}_{i % 10}"] = float(joint[i])
    return out
