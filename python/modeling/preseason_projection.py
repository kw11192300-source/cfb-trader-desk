"""
Learned replacement for the hand-tuned continuity-multiplier shrink in
power_rating.py's preseason snapshot (_shrink_to_mean). That heuristic can
only ever pull a team TOWARD the FBS average - it has no way to say "this
team had a bad prior season but hired a strong coach and landed a great
transfer class, so it should actually project UP, not just toward
average." This module replaces the fixed formula with a model trained to
predict each team's actual early-season strength from exactly the signals
we'd otherwise hand-weight: last season's OWN rating (fit in isolation,
not the multi-year recursive chain), returning production, a new-coach
flag, net transfer-portal stars, and - the piece that lets the model learn
direction, not just magnitude - recruiting/portal TALENT COMPOSITE for
both the incoming and outgoing season (talent_delta captures "the roster
got better/worse this offseason" directly). All of these are genuinely
known before the season starts - no leakage.

Target: that team's OWN power rating fit from ONLY that season's games (no
prior blended in at all) - the cleanest, most independent measurement of
"how good were they, actually" for a completed season. Never overlaps
with the feature set (which only uses data from before the season).

Two regressors (offense, defense - same decomposition as power_rating.py),
same HistGradientBoostingRegressor pattern as outcome_models.py.

See backtest_projection for the walk-forward validation, evaluated two
ways: (1) directly against the season-final target (should the model
predict `overall` well at all) and (2) the way this actually gets used -
MAE predicting real week 1-4 game margins, compared against both the OLD
flat-shrink heuristic and a naive full-carryover baseline (no adjustment
at all - what production had before that fix existed).
"""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

from cfbd_ingest.supabase_client import fetch_all

from .features import POWER_CONFERENCES, _fetch_seasons, _load_games  # noqa: F401 - POWER_CONFERENCES unused here, kept for parity if needed later
from .power_rating import _center, fit_off_def_ratings

FEATURE_COLUMNS = [
    "prior_off",
    "prior_def",
    "prior_overall",
    "returning_ppa_pct",
    "is_new_coach",
    "net_transfer_stars",
    "talent",
    "talent_prior",
    "talent_delta",
    "is_fbs",
]


def _solo_fit(season_games: pd.DataFrame, fbs_teams: set[str]) -> tuple[dict[str, float], dict[str, float]]:
    """That season's off/def rating fit from ONLY that season's own games -
    no prior, no multi-year memory. Used both as the "last season, in
    isolation" feature and as the training target for the target season."""
    if season_games.empty:
        return {}, {}
    off, dfn = fit_off_def_ratings(season_games, "home_points", "away_points")
    return _center(off, dfn, fbs_teams)


def _fbs_team_names(season_games: pd.DataFrame) -> set[str]:
    return set(season_games.loc[season_games["home_classification"] == "fbs", "home_team"]) | set(
        season_games.loc[season_games["away_classification"] == "fbs", "away_team"]
    )


def build_projection_dataset(seasons: list[int]) -> pd.DataFrame:
    """One row per (season, team) for each season in `seasons` - features
    from before that season started, target = that season's own solo-fit
    rating (NaN if the season has no completed games yet, e.g. the
    current in-progress season - still useful for live inference, just
    excluded from training by prepare_xy's dropna)."""
    needed_seasons = sorted(set(seasons) | {s - 1 for s in seasons})
    all_games = _load_games(needed_seasons)
    if all_games.empty:
        return pd.DataFrame()

    id_to_name: dict[int, str] = {}
    for _, g in all_games[["home_id", "home_team"]].drop_duplicates().iterrows():
        id_to_name[g["home_id"]] = g["home_team"]
    for _, g in all_games[["away_id", "away_team"]].drop_duplicates().iterrows():
        id_to_name[g["away_id"]] = g["away_team"]
    name_to_id = {v: k for k, v in id_to_name.items()}

    talent = _fetch_seasons("team_talent", "season,team_id,talent", needed_seasons)
    talent_map = {(r["season"], r["team_id"]): r["talent"] for _, r in talent.iterrows()} if not talent.empty else {}

    returning = _fetch_seasons("team_returning_production", "season,team_id,stats", needed_seasons)
    returning_map = {}
    if not returning.empty:
        for _, r in returning.iterrows():
            stats = r["stats"] if isinstance(r["stats"], dict) else {}
            returning_map[(r["season"], r["team_id"])] = stats.get("percentPPA")

    coaching = _fetch_seasons("team_coaching", "season,team_id,is_new_coach", needed_seasons)
    coaching_map = {(r["season"], r["team_id"]): bool(r["is_new_coach"]) for _, r in coaching.iterrows()} if not coaching.empty else {}

    transfers = _fetch_seasons("player_transfers", "season,origin_team_id,destination_team_id,stars,eligibility", needed_seasons)
    net_transfer_map: dict[tuple[int, int], float] = {}
    if not transfers.empty:
        immediate = transfers[transfers["eligibility"] == "Immediate"].copy()
        incoming = immediate.dropna(subset=["destination_team_id"]).groupby(["season", "destination_team_id"])["stars"].sum()
        outgoing = immediate.dropna(subset=["origin_team_id"]).groupby(["season", "origin_team_id"])["stars"].sum()
        incoming.index.names = outgoing.index.names = ["season", "team_id"]
        net = incoming.sub(outgoing, fill_value=0)
        net_transfer_map = {(int(s), int(t)): float(v) for (s, t), v in net.items()}

    team_class = {t["id"]: t["classification"] for t in fetch_all("teams", "id,classification")}

    rows = []
    for season in seasons:
        prior_games = all_games[all_games["season"] == season - 1]
        target_games = all_games[all_games["season"] == season]
        if prior_games.empty:
            continue  # no prior season on record - can't build features

        prior_off, prior_def = _solo_fit(prior_games, _fbs_team_names(prior_games))
        target_off, target_def = (_solo_fit(target_games, _fbs_team_names(target_games)) if not target_games.empty else ({}, {}))

        teams_this_season = (
            set(target_games["home_team"]) | set(target_games["away_team"]) | set(prior_off.keys()) | set(prior_def.keys())
        )
        for team in teams_this_season:
            team_id = name_to_id.get(team)
            if team_id is None:
                continue
            classification = team_class.get(team_id)
            if classification not in ("fbs", "fcs"):
                continue
            tal = talent_map.get((season, team_id))
            tal_prior = talent_map.get((season - 1, team_id))
            rows.append(
                {
                    "season": season,
                    "team_id": team_id,
                    "team": team,
                    "classification": classification,
                    "is_fbs": classification == "fbs",
                    "prior_off": prior_off.get(team),
                    "prior_def": prior_def.get(team),
                    "prior_overall": (prior_off[team] + prior_def[team]) if team in prior_off and team in prior_def else None,
                    "returning_ppa_pct": returning_map.get((season, team_id)),
                    "is_new_coach": coaching_map.get((season, team_id), False),
                    "net_transfer_stars": net_transfer_map.get((season, team_id)),
                    "talent": tal,
                    "talent_prior": tal_prior,
                    "talent_delta": (tal - tal_prior) if tal is not None and tal_prior is not None else None,
                    "target_off": target_off.get(team),
                    "target_def": target_def.get(team),
                }
            )

    return pd.DataFrame(rows)


def prepare_xy(df: pd.DataFrame, target_col: str) -> tuple[pd.DataFrame, pd.Series]:
    valid = df.dropna(subset=[target_col, "prior_off", "prior_def"])
    X = valid[FEATURE_COLUMNS].astype(float)
    y = valid[target_col].astype(float)
    return X, y


def train_projection_off_model(df: pd.DataFrame, **params) -> HistGradientBoostingRegressor:
    X, y = prepare_xy(df, "target_off")
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y)
    return model


def train_projection_def_model(df: pd.DataFrame, **params) -> HistGradientBoostingRegressor:
    X, y = prepare_xy(df, "target_def")
    model = HistGradientBoostingRegressor(random_state=42, **params)
    model.fit(X, y)
    return model


def predict_projection(off_model, def_model, df: pd.DataFrame) -> pd.DataFrame:
    X = df[FEATURE_COLUMNS].astype(float)
    out = df[["season", "team_id", "team", "classification"]].copy()
    out["predicted_off"] = off_model.predict(X)
    out["predicted_def"] = def_model.predict(X)
    out["predicted_overall"] = out["predicted_off"] + out["predicted_def"]
    return out


def _heuristic_shrink(df: pd.DataFrame) -> pd.DataFrame:
    """Reproduces the CURRENT production heuristic (power_rating._center's
    reference mean + power_rating._shrink_to_mean's multiplier formula,
    inlined here so this module doesn't need a live continuity_multipliers
    dict) - the baseline being challenged."""
    out = df[["season", "team_id", "team", "classification", "prior_off", "prior_def", "is_fbs"]].copy()

    def mult_row(r):
        m = 1.0
        rp = r["returning_ppa_pct"]
        if pd.notna(rp):
            m *= max(0.4, min(1.6, 0.4 + 1.2 * rp))
        if bool(r["is_new_coach"]):
            m *= 0.6
        nts = r["net_transfer_stars"]
        if pd.notna(nts):
            m *= max(0.7, min(1.3, 1 + nts / 50))
        return max(0.2, min(2.0, m))

    out["multiplier"] = df.apply(mult_row, axis=1).clip(upper=1.0)  # capped at 1.0, same as _shrink_to_mean

    for col, out_col in [("prior_off", "heuristic_off"), ("prior_def", "heuristic_def")]:
        fbs_mean = out.loc[out["is_fbs"], col].mean()
        out[out_col] = fbs_mean + out["multiplier"] * (out[col] - fbs_mean)
    out["heuristic_overall"] = out["heuristic_off"] + out["heuristic_def"]
    return out


def _naive_carryover(df: pd.DataFrame) -> pd.Series:
    """The pre-fix production behavior: last season's rating, completely
    unmodified."""
    return df["prior_off"] + df["prior_def"]


def evaluate_projection(model_off, model_def, df: pd.DataFrame) -> dict:
    """Direct evaluation against the season-final target (not the game-
    margin task - see backtest_projection for that)."""
    valid = df.dropna(subset=["target_off", "target_def", "prior_off", "prior_def"])
    if valid.empty:
        return {"n": 0}
    pred = predict_projection(model_off, model_def, valid)
    target_overall = valid["target_off"] + valid["target_def"]
    naive_overall = _naive_carryover(valid)
    heur = _heuristic_shrink(valid)
    return {
        "n": len(valid),
        "model_mae_overall": mean_absolute_error(target_overall, pred["predicted_overall"]),
        "model_r2_overall": r2_score(target_overall, pred["predicted_overall"]),
        "naive_carryover_mae_overall": mean_absolute_error(target_overall, naive_overall),
        "heuristic_mae_overall": mean_absolute_error(target_overall, heur["heuristic_overall"]),
    }


def _game_margin_mae(games: pd.DataFrame, ratings_home: pd.Series, ratings_away: pd.Series, hfa: float) -> float:
    """MAE of predicted margin (rating_home - rating_away + hfa if not
    neutral) vs actual margin, for a set of games with ratings already
    joined in as ratings_home/ratings_away (NaN-safe: drops rows missing
    a rating on either side, e.g. a team with no usable prior)."""
    valid = pd.notna(ratings_home) & pd.notna(ratings_away) & pd.notna(games["home_points"]) & pd.notna(games["away_points"])
    if valid.sum() == 0:
        return float("nan")
    actual_margin = games.loc[valid, "home_points"] - games.loc[valid, "away_points"]
    hfa_applied = np.where(games.loc[valid, "neutral_site"], 0.0, hfa)
    predicted_margin = ratings_home[valid] - ratings_away[valid] + hfa_applied
    return mean_absolute_error(actual_margin, predicted_margin)


def backtest_projection(df: pd.DataFrame, all_games: pd.DataFrame, test_seasons: list[int], early_weeks: int = 4, **params) -> pd.DataFrame:
    """Walk-forward: for each test season, train on every earlier season in
    `df`, then compare three candidate rating sets on real week
    1..early_weeks games from that season:
      - naive: last season's rating, unmodified (pre-fix production)
      - heuristic: current production (continuity-multiplier shrink toward
        FBS average - see power_rating._shrink_to_mean)
      - learned: this module's model

    Returns one row per test season with each candidate's MAE predicting
    actual early-season margins, plus the direct season-final-target MAE
    for reference.
    """
    hfa = float((all_games["home_points"] - all_games["away_points"])[~all_games["neutral_site"]].mean())
    results = []
    for test_season in test_seasons:
        train_df = df[df["season"] < test_season]
        test_df = df[df["season"] == test_season]
        if train_df.empty or test_df.empty:
            continue

        model_off = train_projection_off_model(train_df, **params)
        model_def = train_projection_def_model(train_df, **params)
        direct_eval = evaluate_projection(model_off, model_def, test_df)

        early_games = all_games[(all_games["season"] == test_season) & (all_games["week"] <= early_weeks)].copy()
        if early_games.empty:
            continue

        naive_col = _naive_carryover(test_df)
        heur = _heuristic_shrink(test_df)
        learned = predict_projection(model_off, model_def, test_df.dropna(subset=["prior_off", "prior_def"]))

        naive_by_team = pd.Series(naive_col.to_numpy(), index=test_df["team"])
        heur_by_team = pd.Series(heur["heuristic_overall"].to_numpy(), index=heur["team"])
        learned_by_team = pd.Series(learned["predicted_overall"].to_numpy(), index=learned["team"])

        naive_home = early_games["home_team"].map(naive_by_team)
        naive_away = early_games["away_team"].map(naive_by_team)
        heur_home = early_games["home_team"].map(heur_by_team)
        heur_away = early_games["away_team"].map(heur_by_team)
        learned_home = early_games["home_team"].map(learned_by_team)
        learned_away = early_games["away_team"].map(learned_by_team)

        results.append(
            {
                "test_season": test_season,
                "n_early_games": len(early_games),
                "naive_margin_mae": _game_margin_mae(early_games, naive_home, naive_away, hfa),
                "heuristic_margin_mae": _game_margin_mae(early_games, heur_home, heur_away, hfa),
                "learned_margin_mae": _game_margin_mae(early_games, learned_home, learned_away, hfa),
                "direct_model_mae_overall": direct_eval.get("model_mae_overall"),
                "direct_heuristic_mae_overall": direct_eval.get("heuristic_mae_overall"),
                "direct_naive_mae_overall": direct_eval.get("naive_carryover_mae_overall"),
            }
        )

    return pd.DataFrame(results)


def save_model(model, path: str) -> None:
    joblib.dump(model, path)


def load_model(path: str):
    return joblib.load(path)


def run(seasons: list[int], test_seasons: list[int]) -> None:
    print(f"Building projection dataset for {min(seasons)}-{max(seasons)}...")
    df = build_projection_dataset(seasons)
    print(f"{len(df)} team-season rows ({df['target_off'].notna().sum()} with a settled target).")

    all_games = _load_games(seasons)

    print(f"\n=== Preseason projection backtest (train < test season, early_weeks=4) ===")
    report = backtest_projection(df, all_games, test_seasons)
    print(report.round(3).to_string(index=False))
    print("\nAverages across all test seasons:")
    print(report.drop(columns=["test_season", "n_early_games"]).mean().round(3))


if __name__ == "__main__":
    run(list(range(2016, 2027)), list(range(2021, 2027)))
