"""
Massey-style power ratings fit to historical closing spreads — "what has
the market collectively thought of this team, smoothed across many games."

This is deliberately NOT "use this week's own market line as a feature" —
that would just teach the outcome models to parrot whatever the market
currently says. Instead, each team's rating here is fit from spreads in
GAMES ALREADY PLAYED before the target week, so it reflects the market's
aggregate judgment up to that point without ever looking at the specific
line for the game being predicted.

Ratings are computed per (season, week) checkpoint, expanding within a
season (more games = the fit leans more on this season's own evidence) and
shrunk toward the previous season's FINAL rating as a prior (a team with 0
games played yet in a new season starts at last year's rating; by ~6 games
in, this year's results dominate). The recursion bottoms out at the first
season with no prior at all (rating defaults to 0 for everyone, i.e. no
opinion yet).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HFA_KEY = "__hfa__"
DEFAULT_PRIOR_WEIGHT = 4.0  # prior counts as ~4 "virtual games" of pull


def fit_market_ratings(games: pd.DataFrame, prior: dict[str, float] | None = None, prior_weight: float = DEFAULT_PRIOR_WEIGHT) -> dict[str, float]:
    """
    games: DataFrame with columns home_team, away_team, spread (home-team
    convention: negative = home favored), neutral_site.
    prior: {team: rating} to shrink toward — teams missing from `games`
    entirely just keep their prior rating unchanged.
    Returns {team: rating}, plus a HFA_KEY entry for the fitted home-field
    constant. Empty/degenerate input returns prior as-is (or {} with no prior).
    """
    teams = sorted(set(games["home_team"]) | set(games["away_team"]) | set((prior or {}).keys()))
    if not teams:
        return {}
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)

    rows: list[np.ndarray] = []
    targets: list[float] = []
    for _, g in games.iterrows():
        if pd.isna(g["spread"]):
            continue
        row = np.zeros(n + 1)
        row[idx[g["home_team"]]] = 1
        row[idx[g["away_team"]]] = -1
        if not g["neutral_site"]:
            row[n] = 1  # HFA column
        rows.append(row)
        targets.append(-float(g["spread"]))  # spread is negative when home is favored -> -spread = market's implied home margin

    if prior:
        w = prior_weight**0.5
        for t, p in prior.items():
            row = np.zeros(n + 1)
            row[idx[t]] = w
            rows.append(row)
            targets.append(p * w)

    if not rows:
        return dict(prior or {})

    A = np.array(rows)
    b = np.array(targets)
    solution, *_ = np.linalg.lstsq(A, b, rcond=None)
    ratings = {t: float(solution[i]) for t, i in idx.items()}
    ratings[HFA_KEY] = float(solution[n]) if prior or len(rows) > n else 0.0
    return ratings


def compute_expanding_market_ratings(games: pd.DataFrame) -> pd.DataFrame:
    """
    games: full historical set, columns: season, week, home_team, away_team,
    spread, neutral_site, start_date. Must be games with a known closing
    spread (already-played games only — this is a retrospective "what did
    the market think" signal, not usable for games that haven't closed yet).

    Returns one row per (season, week, team): the team's market-implied
    rating fit from every game in that season strictly before `week`,
    shrunk toward the previous season's final rating. Use this by looking
    up (season, week_of_target_game, team) — never the target game's own
    season+week using games that include itself.
    """
    games = games.dropna(subset=["spread"]).sort_values(["season", "week"])
    out_rows = []
    prior: dict[str, float] | None = None

    for season, season_games in games.groupby("season"):
        weeks = sorted(season_games["week"].unique())
        season_final = prior  # will be overwritten with this season's own final fit at the end
        for week in weeks:
            before = season_games[season_games["week"] < week]
            ratings = fit_market_ratings(before, prior=prior) if len(before) > 0 else dict(prior or {})
            for team, rating in ratings.items():
                if team == HFA_KEY:
                    continue
                out_rows.append({"season": season, "week": week, "team": team, "market_rating": rating})
        # Season-final rating (all of this season's games) becomes next season's prior.
        season_final = fit_market_ratings(season_games, prior=prior)
        prior = {t: r for t, r in season_final.items() if t != HFA_KEY}

    return pd.DataFrame(out_rows)
