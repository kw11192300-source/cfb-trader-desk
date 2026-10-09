"""
Team-level baseline: expected regulation goals for each side of a game from
attack/defense ratings, then win / total / puck-line probabilities from the
resulting score distribution. Deliberately simple - this is the benchmark
everything fancier (the strength-state simulation, player-level priors) has
to beat, and the thing that proves the data pipeline end to end.

    log(lambda_team) = mu + home*beta + attack[team] + defense[opponent]

fit as a Poisson regression on past games only, with:

  * Targets that blend actual goals with xG (`goal_weight`). Goals are the
    outcome we're predicting but are mostly luck over a few games; xG is
    the same game's chances, far less noisy. Both on the same scale
    (xG is scaled so its league total matches official goals - official
    goals include empty-net goals, xG excludes them).
  * Exponential time decay (`half_life_days`) so recent games count more.
    The first games of a season have NO current-season data - last
    season's games, decayed, are all there is, which is exactly the
    cold-start behavior wanted. Roster turnover is NOT modeled here (that's
    the player-level step); a team that lost its goalie is rated as if it
    hadn't.
  * A ridge prior pulling every rating to league average, specified in
    effective weighted GAMES per team (`prior_games`) rather than a raw
    sklearn alpha: with sklearn's averaged objective a plain alpha shrinks
    a 5-game sample and a 500-game sample identically, which is the
    opposite of what's wanted. alpha = 3 * prior_games / sum(weights)
    makes the prior worth a fixed number of games regardless of how much
    data there is (3 ~ goals per team-game = Poisson curvature per row).

Regulation only, throughout - overtime is 3v3 sudden death and a different
sport. The conversion to the game's final result lives in score_matrix():
a regulation tie always adds exactly one goal to the final score (an
overtime goal, or the shootout winner's credited goal), which is what
full-game totals settle on at US books.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.linear_model import PoissonRegressor

warnings.filterwarnings("ignore", message="Unknown solver options")

MAX_GOALS = 14


@dataclass
class Config:
    half_life_days: float = 150.0
    prior_games: float = 20.0
    goal_weight: float = 0.3
    lookback_days: int = 1100


@dataclass
class Fit:
    teams: dict[int, int]
    mu: float
    home: float
    attack: np.ndarray
    defense: np.ndarray
    ot_home_share: float
    cfg: Config

    def lambdas(self, home_id: int, away_id: int) -> tuple[float, float]:
        ia, ib = self.teams.get(home_id), self.teams.get(away_id)
        att_h = self.attack[ia] if ia is not None else 0.0
        def_h = self.defense[ia] if ia is not None else 0.0
        att_a = self.attack[ib] if ib is not None else 0.0
        def_a = self.defense[ib] if ib is not None else 0.0
        return float(np.exp(self.mu + self.home + att_h + def_a)), float(np.exp(self.mu + att_a + def_h))


def fit_ratings(tg: pd.DataFrame, as_of: pd.Timestamp, cfg: Config) -> Fit | None:
    """`tg` is team_games.csv.gz; only rows strictly before `as_of` are used."""
    train = tg[(tg["start_utc"] < as_of) & (tg["start_utc"] >= as_of - pd.Timedelta(days=cfg.lookback_days))]
    if len(train) < 400:
        return None
    teams = {t: i for i, t in enumerate(sorted(set(train["team_id"]) | set(train["opp_id"])))}
    n = len(teams)
    scale = train["goals_for_reg_official"].sum() / max(train["xg_reg"].sum(), 1e-9)
    y = cfg.goal_weight * train["goals_for_reg_official"] + (1 - cfg.goal_weight) * scale * train["xg_reg"]
    age = (as_of - train["start_utc"]).dt.total_seconds() / 86400.0
    w = np.exp(-np.log(2) * age / cfg.half_life_days).to_numpy()

    X = np.zeros((len(train), 1 + 2 * n))
    X[:, 0] = train["is_home"].to_numpy()
    X[np.arange(len(train)), 1 + train["team_id"].map(teams).to_numpy()] = 1.0
    X[np.arange(len(train)), 1 + n + train["opp_id"].map(teams).to_numpy()] = 1.0

    alpha = 3.0 * cfg.prior_games / w.sum()
    m = PoissonRegressor(alpha=alpha, max_iter=500, tol=1e-6).fit(X, y.to_numpy(), sample_weight=w)
    coef = m.coef_
    # center the ratings so attack/defense are deviations from league average
    att, dfn = coef[1 : 1 + n], coef[1 + n :]
    mu = m.intercept_ + att.mean() + dfn.mean()

    # how often does the home team win once it's past regulation? (OT/SO games only, same decay)
    ot = train[(train["is_home"] == 1) & (train["last_period"] != "REG")]
    ot_share = float(np.average(ot["final_for"] > ot["final_against"], weights=w[train.index.get_indexer(ot.index)])) if len(ot) > 50 else 0.5
    return Fit(teams, mu, float(coef[0]), att - att.mean(), dfn - dfn.mean(), ot_share, cfg)


def score_matrix(lam_h: float, lam_a: float) -> np.ndarray:
    """P(home reg goals = i, away reg goals = j), independent Poisson."""
    ph = poisson.pmf(np.arange(MAX_GOALS + 1), lam_h)
    pa = poisson.pmf(np.arange(MAX_GOALS + 1), lam_a)
    return np.outer(ph, pa)


def summarize(lam_h: float, lam_a: float, ot_home_share: float) -> dict:
    """Everything the markets need from one score matrix.

    final-score convention (what US books settle full-game over/under on): a
    regulation tie always becomes a one-goal game - an OT goal or the
    shootout winner's credited goal - so final total = regulation total + 1
    when tied. Puck line -1.5 needs a 2+ goal REGULATION margin: a game that
    goes past regulation is always decided by exactly one goal."""
    m = score_matrix(lam_h, lam_a)
    idx = np.arange(m.shape[0])
    diff = idx[:, None] - idx[None, :]
    p_tie = float(np.trace(m))
    p_home_reg = float(m[diff > 0].sum())
    p_away_reg = float(m[diff < 0].sum())
    out = {
        "lam_h": lam_h, "lam_a": lam_a,
        "p_tie_reg": p_tie,
        "p_home": p_home_reg + p_tie * ot_home_share,
        "p_home_reg": p_home_reg, "p_away_reg": p_away_reg,
        "p_home_cover_m15": float(m[diff >= 2].sum()),   # home -1.5
        "p_away_cover_m15": float(m[diff <= -2].sum()),  # away -1.5
    }
    total = idx[:, None] + idx[None, :]
    # final-score total distribution
    final_total = np.zeros(2 * MAX_GOALS + 3)
    for i in idx:
        for j in idx:
            final_total[i + j + (1 if i == j else 0)] += m[i, j]
    out["exp_total_final"] = float((np.arange(final_total.size) * final_total).sum())
    out["exp_total_reg"] = lam_h + lam_a
    for line in (4.5, 5.5, 6.5, 7.5):
        out[f"p_over_{line}"] = float(final_total[int(line) + 1 :].sum())
    return out
