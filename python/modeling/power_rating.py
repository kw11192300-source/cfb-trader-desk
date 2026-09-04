"""
CFB Trader Desk Power Rating — our own from-scratch offense/defense rating
system, independent of CFBD's SP+/FPI/Elo (proprietary formulas we don't
control or fully understand) and independent of the market. Two components,
each its own Massey-style linear system solved by least squares:

  - SCORING ratings: fit directly to actual points scored/allowed per game.
    Each team gets an offense rating (points scored vs an average defense)
    and a defense rating (points ALLOWED vs an average offense, sign-
    flipped so higher is always better, matching offense's convention).
    Classification-agnostic - works for FCS, unlike Elo/SP+/FPI.

  - EFFICIENCY ratings: same decomposition, fit to PPA (predicted points
    added) per game instead of raw points. PPA already blends success
    rate, explosiveness, and down/distance context into one number, so
    this captures underlying process quality with less game-to-game
    scoring variance (garbage time, a missed extra point, weather) than
    raw points carry.

OVERALL rating = offense rating - defense-points-allowed rating (scoring
basis) - "expected point differential against a league-average opponent."
Both scoring and efficiency ratings are exposed separately since they
sometimes disagree (see compute_power_ratings.py's backtest note) and a
model or a viewer may want either signal.

Same point-in-time-safe design as market_rating.py: ratings "as of week W"
are fit only from games strictly before W, shrunk toward the previous
season's final rating as a prior.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HFA_KEY = "__hfa__"
DEFAULT_PRIOR_WEIGHT = 4.0


def fit_off_def_ratings(
    games: pd.DataFrame,
    home_col: str,
    away_col: str,
    prior_off: dict[str, float] | None = None,
    prior_def: dict[str, float] | None = None,
    prior_weight: float = DEFAULT_PRIOR_WEIGHT,
    prior_weight_multipliers: dict[str, float] | None = None,
) -> tuple[dict[str, float], dict[str, float]]:
    """
    games: columns home_team, away_team, neutral_site, and two value
    columns (named by home_col/away_col) - what the home/away team
    produced in that game (points, or PPA). Two rows per game: one for the
    home team's offense against the away team's defense, one for the
    reverse. def[team] is fit as "points/PPA ALLOWED" (lower = better) and
    then sign-flipped before returning so higher is always better for both
    offense and defense, matching convention.

    prior_weight_multipliers: {team: multiplier}, applied on top of
    prior_weight per team - how much last season's rating should be
    trusted heading into a new season. A team that returned little
    production, lost more transfer talent than it gained, and/or has a new
    head coach should have this well below 1 (lean on early in-season
    results faster instead of a stale, less-relevant prior); a team with
    high continuity should be at or above 1. Missing from the dict = 1.0
    (no adjustment). See features.py's build_continuity_multipliers.

    Returns (offense_ratings, defense_ratings) - each {team: rating}.
    """
    teams = sorted(set(games["home_team"]) | set(games["away_team"]) | set((prior_off or {}).keys()) | set((prior_def or {}).keys()))
    if not teams:
        return {}, {}
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    # Columns: [off_1..off_n, def_allowed_1..def_allowed_n, HFA]
    off_col = lambda t: idx[t]  # noqa: E731
    def_col = lambda t: n + idx[t]  # noqa: E731
    hfa_col = 2 * n

    rows: list[np.ndarray] = []
    targets: list[float] = []
    for _, g in games.iterrows():
        home_val, away_val = g[home_col], g[away_col]
        neutral = bool(g["neutral_site"])
        if pd.notna(home_val):
            row = np.zeros(2 * n + 1)
            row[off_col(g["home_team"])] = 1
            row[def_col(g["away_team"])] = 1  # away's defense "allowed" this
            if not neutral:
                row[hfa_col] = 1
            rows.append(row)
            targets.append(float(home_val))
        if pd.notna(away_val):
            row = np.zeros(2 * n + 1)
            row[off_col(g["away_team"])] = 1
            row[def_col(g["home_team"])] = 1
            rows.append(row)
            targets.append(float(away_val))

    def team_weight(t: str) -> float:
        mult = (prior_weight_multipliers or {}).get(t, 1.0)
        return (prior_weight * mult) ** 0.5

    if prior_off:
        for t, p in prior_off.items():
            w = team_weight(t)
            row = np.zeros(2 * n + 1)
            row[off_col(t)] = w
            rows.append(row)
            targets.append(p * w)
    if prior_def:
        for t, p in prior_def.items():
            w = team_weight(t)
            row = np.zeros(2 * n + 1)
            row[def_col(t)] = w
            rows.append(row)
            targets.append(-p * w)  # prior_def is stored "higher=better"; internal def_allowed is "lower=better"

    if not rows:
        return dict(prior_off or {}), dict(prior_def or {})

    A = np.array(rows)
    b = np.array(targets)
    solution, *_ = np.linalg.lstsq(A, b, rcond=None)
    offense = {t: float(solution[off_col(t)]) for t in teams}
    defense = {t: -float(solution[def_col(t)]) for t in teams}  # flip sign: higher = better, consistent with offense
    return offense, defense


def _center(
    off: dict[str, float], dfn: dict[str, float], fbs_teams: set[str] | None = None
) -> tuple[dict[str, float], dict[str, float]]:
    """Centers offense and defense each around a reference mean (0 = that
    reference unit) so the ratings read the standard, interpretable way -
    "overall" differences between two teams line up with expected point
    margin (see fit_off_def_ratings docstring math).

    fbs_teams, when given, restricts the reference mean to only FBS teams'
    ratings - so 0 means "average FBS team," not "average of every rated
    team including FCS." FBS and FCS still share one linear system (linked
    by real cross-division buy games, which is what lets us price those
    games at all), but centering on the combined pool would understate how
    far below FBS the average FCS team actually is (FCS teams pull the
    pool average down, making FBS ratings look inflated relative to what a
    standalone FBS-only system would show, e.g. SP+). Falls back to the
    full pool if fbs_teams is empty/None or none of it is present yet
    (e.g. very early in a rebuild before any FBS team has a rating).

    Mathematically free either way: mean(off) and mean(def) over the SAME
    reference set are always exact negatives of each other by construction
    (every point scored by someone is allowed by someone else - same
    shared total), so off_centered + def_centered == off + def exactly -
    "overall" (their sum) is unaffected by which reference set is used,
    only the individual O/D split's zero point moves.
    """
    if not off or not dfn:
        return off, dfn
    ref_off = {t: v for t, v in off.items() if fbs_teams and t in fbs_teams} or off
    ref_def = {t: v for t, v in dfn.items() if fbs_teams and t in fbs_teams} or dfn
    mean_off = sum(ref_off.values()) / len(ref_off)
    mean_def = sum(ref_def.values()) / len(ref_def)
    return {t: v - mean_off for t, v in off.items()}, {t: v - mean_def for t, v in dfn.items()}


def _shrink_to_mean(
    ratings: dict[str, float], fbs_teams: set[str] | None, multipliers: dict[str, float]
) -> dict[str, float]:
    """Pulls each team's rating toward the reference mean by its own
    continuity multiplier - used ONLY for the preseason snapshot (zero
    games played yet this season), where fit_off_def_ratings' normal
    weighted-prior mechanism has no real in-season evidence to weigh the
    prior against, so a low multiplier (new coach, almost nobody
    returning) would otherwise be silently ignored until games accumulate.
    Multiplier is capped at 1.0 here - preseason, there's no new evidence
    to justify pushing a team FARTHER from the mean than its own prior
    rating already implies, only reason to pull it back in."""
    if not ratings:
        return ratings
    ref = {t: v for t, v in ratings.items() if fbs_teams and t in fbs_teams} or ratings
    mean = sum(ref.values()) / len(ref)
    return {t: mean + min(multipliers.get(t, 1.0), 1.0) * (v - mean) for t, v in ratings.items()}


def _compute_expanding_off_def(
    games: pd.DataFrame,
    home_col: str,
    away_col: str,
    off_name: str,
    def_name: str,
    continuity_multipliers: dict[tuple[int, str], float] | None = None,
    fbs_teams: set[str] | None = None,
) -> pd.DataFrame:
    """continuity_multipliers: {(season, team): multiplier} - see
    fit_off_def_ratings' prior_weight_multipliers docstring. Looked up
    fresh each season since it reflects THAT season's roster turnover.

    fbs_teams: {team names} used only to pick the centering reference -
    see _center's docstring. Not used to filter games (FBS/FCS still fit
    together in one system).

    `weeks` comes from EVERY row passed in (games_for_weeks), not just the
    ones with a real result (games_for_fit) - see market_rating.py's
    identical fix for why: an upcoming week with nothing completed yet
    still needs a carried-forward rating emitted for it (live scoring),
    even though it obviously can't contribute fitting evidence."""
    games_for_weeks = games.sort_values(["season", "week"])
    games_for_fit = games.dropna(subset=[home_col, away_col], how="all").sort_values(["season", "week"])
    out_rows = []
    prior_off: dict[str, float] | None = None
    prior_def: dict[str, float] | None = None

    for season, season_games in games_for_weeks.groupby("season"):
        season_multipliers = {t: m for (s, t), m in (continuity_multipliers or {}).items() if s == season}
        fit_games_season = games_for_fit[games_for_fit["season"] == season]
        weeks = sorted(season_games["week"].unique())
        for week in weeks:
            before = fit_games_season[fit_games_season["week"] < week]
            if len(before) > 0:
                off, dfn = fit_off_def_ratings(before, home_col, away_col, prior_off, prior_def, prior_weight_multipliers=season_multipliers)
            else:
                # No real games yet this season - shrink the carried-over
                # prior toward the reference mean by continuity (see
                # _shrink_to_mean) instead of showing it unmodified. Only
                # affects this week's OUTPUT row; prior_off/prior_def
                # themselves stay the true unshrunk fit so next week's real
                # blend (the `if` branch above) still has an unbiased prior
                # to weigh actual results against.
                off = _shrink_to_mean(dict(prior_off or {}), fbs_teams, season_multipliers)
                dfn = _shrink_to_mean(dict(prior_def or {}), fbs_teams, season_multipliers)
            # Centered for the OUTPUT (interpretable, 0 = average FBS team) -
            # the uncentered off/dfn (below) keep chaining as the prior, so
            # centering here doesn't drift the internal fit across weeks.
            off_out, dfn_out = _center(off, dfn, fbs_teams)
            teams = set(off_out.keys()) | set(dfn_out.keys())
            for team in teams:
                out_rows.append({"season": season, "week": week, "team": team, off_name: off_out.get(team), def_name: dfn_out.get(team)})
        prior_off, prior_def = fit_off_def_ratings(fit_games_season, home_col, away_col, prior_off, prior_def, prior_weight_multipliers=season_multipliers)

    return pd.DataFrame(out_rows)


def compute_expanding_scoring_ratings(
    games: pd.DataFrame, continuity_multipliers: dict[tuple[int, str], float] | None = None, fbs_teams: set[str] | None = None
) -> pd.DataFrame:
    """games: season, week, home_team, away_team, home_points, away_points, neutral_site."""
    return _compute_expanding_off_def(games, "home_points", "away_points", "scoring_off", "scoring_def", continuity_multipliers, fbs_teams)


def compute_expanding_efficiency_ratings(
    games: pd.DataFrame, continuity_multipliers: dict[tuple[int, str], float] | None = None, fbs_teams: set[str] | None = None
) -> pd.DataFrame:
    """games: season, week, home_team, away_team, home_ppa, away_ppa, neutral_site
    (home_ppa/away_ppa = that team's own offensive PPA in that specific game)."""
    return _compute_expanding_off_def(games, "home_ppa", "away_ppa", "efficiency_off", "efficiency_def", continuity_multipliers, fbs_teams)
