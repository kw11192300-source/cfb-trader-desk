"""
Massey-style power ratings — a linear system fit so that
rating[home] - rating[away] + home_field_advantage ≈ some target margin,
solved by least squares across every game in the fitting window, shrunk
toward the previous season's final rating as a prior.

Two ratings built on this same machinery, each fit to a different target:

  - MARKET rating (compute_expanding_market_ratings): target = the
    market's own implied margin (-spread). "What has the market thought of
    this team, smoothed across many games." See features.py's docstring
    for why this is used as a feature (an aggregate signal) rather than
    the target game's own line (which would just teach models to parrot
    today's number).

  - RESULTS rating (compute_expanding_results_ratings): target = the
    team's ACTUAL game margin. A genuinely independent, from-scratch power
    rating — not reusing CFBD's SP+/FPI/Elo formulas, not derived from the
    market at all. Classification-agnostic: since it only needs games and
    final scores, it works for FCS too, unlike Elo/SP+/FPI (FBS-only,
    verified live).

Both are computed per (season, week) checkpoint, expanding within a season
(more games played = the fit leans more on this season's own evidence),
recursing season-to-season via the prior-season-final-as-prior shrinkage.
Always point-in-time safe: a team's rating "as of week W" is fit only from
games strictly before W.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HFA_KEY = "__hfa__"
DEFAULT_PRIOR_WEIGHT = 4.0  # prior counts as ~4 "virtual games" of pull


def fit_massey_ratings(
    games: pd.DataFrame,
    prior: dict[str, float] | None = None,
    prior_weight: float = DEFAULT_PRIOR_WEIGHT,
    prior_weight_multipliers: dict[str, float] | None = None,
) -> dict[str, float]:
    """
    games: DataFrame with columns home_team, away_team, target_margin
    (home-perspective: positive = home won/was favored by that much),
    neutral_site.
    prior: {team: rating} to shrink toward — teams missing from `games`
    entirely just keep their prior rating unchanged.
    prior_weight_multipliers: {team: multiplier} - how much to trust each
    team's own prior, same convention as power_rating.py's
    fit_off_def_ratings (built from returning production/coaching
    change/transfer activity - see features.py's build_continuity_multipliers).
    Missing from the dict = 1.0 (no adjustment).
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
        if pd.isna(g["target_margin"]):
            continue
        row = np.zeros(n + 1)
        row[idx[g["home_team"]]] = 1
        row[idx[g["away_team"]]] = -1
        if not g["neutral_site"]:
            row[n] = 1  # HFA column
        rows.append(row)
        targets.append(float(g["target_margin"]))

    if prior:
        for t, p in prior.items():
            mult = (prior_weight_multipliers or {}).get(t, 1.0)
            w = (prior_weight * mult) ** 0.5
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


def _shrink_to_mean(ratings: dict[str, float], fbs_teams: set[str] | None, multipliers: dict[str, float]) -> dict[str, float]:
    """Same fix as power_rating.py's _shrink_to_mean, same reason: at week 1
    (zero games played yet this season), fit_massey_ratings' weighted-prior
    mechanism has no real in-season evidence to weigh the prior against, so a
    low continuity multiplier (new coach, almost nobody returning) would
    otherwise be silently ignored until games accumulate - and this is the
    SINGLE MOST IMPORTANT feature pair in the outcome model
    (home/away_results_rating, ~30%+ combined importance), which had never
    gotten this fix, unlike the power ratings shown on /ratings. Reference
    mean is FBS teams only, same convention as power_rating.py; multiplier
    capped at 1.0 (only pull toward the mean, never push further from it -
    no new evidence yet to justify that)."""
    if not ratings:
        return ratings
    ref = {t: v for t, v in ratings.items() if fbs_teams and t in fbs_teams} or ratings
    mean = sum(ref.values()) / len(ref)
    return {t: mean + min(multipliers.get(t, 1.0), 1.0) * (v - mean) for t, v in ratings.items()}


def _compute_expanding_ratings(
    games: pd.DataFrame,
    value_col: str,
    continuity_multipliers: dict[tuple[int, str], float] | None = None,
    fbs_teams: set[str] | None = None,
) -> pd.DataFrame:
    """Shared expanding/recursive computation - games must already have a
    `target_margin` column (caller decides what that means).

    continuity_multipliers: {(season, team): multiplier}, fbs_teams: used
    only for the week-1 shrink's reference mean - see _shrink_to_mean and
    power_rating.py's identical fix."""
    games = games.dropna(subset=["target_margin"]).sort_values(["season", "week"])
    out_rows = []
    prior: dict[str, float] | None = None

    for season, season_games in games.groupby("season"):
        season_multipliers = {t: m for (s, t), m in (continuity_multipliers or {}).items() if s == season}
        weeks = sorted(season_games["week"].unique())
        for week in weeks:
            before = season_games[season_games["week"] < week]
            if len(before) > 0:
                ratings = fit_massey_ratings(before, prior=prior, prior_weight_multipliers=season_multipliers)
            else:
                ratings = _shrink_to_mean(dict(prior or {}), fbs_teams, season_multipliers)
            for team, rating in ratings.items():
                if team == HFA_KEY:
                    continue
                out_rows.append({"season": season, "week": week, "team": team, value_col: rating})
        # Season-final rating (all of this season's games) becomes next season's prior.
        # Unshrunk - the shrink is only for the OUTPUT at week 1, same reasoning
        # as power_rating.py (next season's week-1 branch needs the true
        # unshrunk prior to weigh real evidence against once games start).
        season_final = fit_massey_ratings(season_games, prior=prior, prior_weight_multipliers=season_multipliers)
        prior = {t: r for t, r in season_final.items() if t != HFA_KEY}

    return pd.DataFrame(out_rows)


def compute_expanding_market_ratings(
    games: pd.DataFrame, continuity_multipliers: dict[tuple[int, str], float] | None = None, fbs_teams: set[str] | None = None
) -> pd.DataFrame:
    """
    games: full historical set, columns: season, week, home_team, away_team,
    spread, neutral_site. Must be games with a known closing spread
    (already-played games only — this is a retrospective "what did the
    market think" signal, not usable for games that haven't closed yet).

    Returns one row per (season, week, team): the team's market-implied
    rating (column "market_rating") as of that week - see module docstring.
    """
    games = games.copy()
    games["target_margin"] = -games["spread"]  # spread negative when home favored -> -spread = market's implied home margin
    return _compute_expanding_ratings(games, "market_rating", continuity_multipliers, fbs_teams)


def compute_expanding_results_ratings(
    games: pd.DataFrame, continuity_multipliers: dict[tuple[int, str], float] | None = None, fbs_teams: set[str] | None = None
) -> pd.DataFrame:
    """
    games: full historical set, columns: season, week, home_team, away_team,
    actual_margin, neutral_site. Only needs games + final scores - works
    for FCS too, unlike Elo/SP+/FPI.

    Returns one row per (season, week, team): the team's from-scratch
    results-based rating (column "results_rating") as of that week.
    """
    games = games.copy()
    games["target_margin"] = games["actual_margin"]
    return _compute_expanding_ratings(games, "results_rating", continuity_multipliers, fbs_teams)
