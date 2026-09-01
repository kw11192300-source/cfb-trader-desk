"""
Computes CURRENT power ratings (as of the latest completed week) for every
team and writes a one-row-per-team snapshot to team_power_ratings — what
the site's Power Ratings tab reads. Reuses build_training_dataset's data
loading, then takes the LAST (most recent season+week) row per team from
the scoring/efficiency off-def systems.

Usage:
    python -m modeling.sync_power_ratings
"""
from __future__ import annotations

import datetime

import pandas as pd

from cfbd_ingest.supabase_client import fetch_all, get_client

from .features import _load_games, build_continuity_multipliers, _fetch_seasons  # noqa: F401 - internal reuse, same package
from .power_rating import compute_expanding_efficiency_ratings, compute_expanding_scoring_ratings
from .preseason_projection import build_projection_dataset, predict_projection, train_projection_def_model, train_projection_off_model


def run() -> None:
    year = datetime.date.today().year
    seasons = [year - 1, year]
    print(f"Loading games for {seasons}...")
    games = _load_games(seasons)
    if games.empty:
        print("No games found - nothing to compute.")
        return

    print("Loading team game stats for efficiency ratings...")
    game_ids = games["id"].tolist()
    from .features import _load_team_game_stats  # local import - avoid circular concerns at module load

    game_stats = _load_team_game_stats(game_ids)

    print("Loading continuity signals...")
    returning = _fetch_seasons("team_returning_production", "season,team_id,stats", seasons)
    if not returning.empty:
        returning["returning_ppa_pct"] = returning["stats"].apply(lambda s: s.get("percentPPA") if isinstance(s, dict) else None)
    transfers = _fetch_seasons("player_transfers", "season,origin_team_id,destination_team_id,stars,eligibility", seasons)
    net_transfer_stars = pd.DataFrame(columns=["season", "team_id", "net_transfer_stars"])
    if not transfers.empty:
        immediate = transfers[transfers["eligibility"] == "Immediate"].copy()
        incoming = immediate.dropna(subset=["destination_team_id"]).groupby(["season", "destination_team_id"])["stars"].sum()
        outgoing = immediate.dropna(subset=["origin_team_id"]).groupby(["season", "origin_team_id"])["stars"].sum()
        incoming.index.names = outgoing.index.names = ["season", "team_id"]
        net_transfer_stars = incoming.sub(outgoing, fill_value=0).reset_index(name="net_transfer_stars")
    coaching = _fetch_seasons("team_coaching", "season,team_id,is_new_coach", seasons)

    id_to_name = pd.Series(games["home_team"].values, index=games["home_id"]).to_dict()
    id_to_name.update(pd.Series(games["away_team"].values, index=games["away_id"]).to_dict())
    continuity_multipliers = build_continuity_multipliers(seasons, returning, net_transfer_stars, coaching, id_to_name)

    # Names, not ids - used only to pick the centering reference (0 =
    # average FBS team). See power_rating._center's docstring.
    fbs_teams = set(games.loc[games["home_classification"] == "fbs", "home_team"]) | set(
        games.loc[games["away_classification"] == "fbs", "away_team"]
    )

    print("Computing scoring ratings...")
    scoring = compute_expanding_scoring_ratings(
        games[["season", "week", "home_team", "away_team", "home_points", "away_points", "neutral_site"]], continuity_multipliers, fbs_teams
    )

    print("Computing efficiency ratings...")
    ppa_by_game_team = game_stats[["game_id", "team_id", "off_ppa"]] if not game_stats.empty else pd.DataFrame(columns=["game_id", "team_id", "off_ppa"])
    ppa_input = games.merge(
        ppa_by_game_team.rename(columns={"team_id": "home_id", "off_ppa": "home_ppa"}), left_on=["id", "home_id"], right_on=["game_id", "home_id"], how="left"
    ).merge(ppa_by_game_team.rename(columns={"team_id": "away_id", "off_ppa": "away_ppa"}), left_on=["id", "away_id"], right_on=["game_id", "away_id"], how="left")
    efficiency = compute_expanding_efficiency_ratings(
        ppa_input[["season", "week", "home_team", "away_team", "home_ppa", "away_ppa", "neutral_site"]], continuity_multipliers, fbs_teams
    )

    # Current snapshot = each team's LATEST (season, week) row.
    scoring_latest = scoring.sort_values(["season", "week"]).groupby("team").tail(1).set_index("team")
    efficiency_latest = efficiency.sort_values(["season", "week"]).groupby("team").tail(1).set_index("team")

    # Preseason override: for any team with zero completed games so far
    # THIS season, replace the continuity-shrink heuristic scoring rating
    # (power_rating._shrink_to_mean - a flat "pull toward FBS average"
    # formula, blind to whether a coaching/roster change is an upgrade or
    # a downgrade) with a learned projection model instead - see
    # preseason_projection.py. Backtested walk-forward 2021-2026: beats
    # both the shrink heuristic and a naive unmodified-carryover baseline
    # on real early-season (weeks 1-4) game margins. Efficiency ratings
    # aren't covered by this model yet (points-based target only) - still
    # on the plain heuristic for now.
    print("Training preseason projection model (scoring ratings only)...")
    proj_seasons = list(range(year - 9, year + 1))
    proj_df = build_projection_dataset(proj_seasons)
    proj_train = proj_df[proj_df["season"] < year]
    current_rows = proj_df[(proj_df["season"] == year) & proj_df["prior_off"].notna() & proj_df["prior_def"].notna()]
    projected_by_team: dict[str, tuple[float, float]] = {}
    if not proj_train.empty and not current_rows.empty:
        off_model = train_projection_off_model(proj_train)
        def_model = train_projection_def_model(proj_train)
        projected = predict_projection(off_model, def_model, current_rows)
        projected_by_team = {r["team"]: (r["predicted_off"], r["predicted_def"]) for _, r in projected.iterrows()}
        print(f"  Projected {len(projected_by_team)} teams; overriding preseason (0-game) rows below.")
    played_this_season = set(games.loc[games["season"] == year, "home_team"]) | set(games.loc[games["season"] == year, "away_team"])

    name_to_id = {v: k for k, v in id_to_name.items()}
    team_class = {t["id"]: t["classification"] for t in fetch_all("teams", "id,classification")}

    records = []
    all_teams = set(scoring_latest.index) | set(efficiency_latest.index)
    for team in all_teams:
        team_id = name_to_id.get(team)
        if team_id is None:
            continue
        # Defense in depth against _load_games' fbs/fcs filter: never write
        # a rating row for a team the teams table doesn't call fbs or fcs
        # (D2/D3 buy-game opponents, defunct/unclassified entries, etc).
        if team_class.get(team_id) not in ("fbs", "fcs"):
            continue
        s = scoring_latest.loc[team] if team in scoring_latest.index else None
        e = efficiency_latest.loc[team] if team in efficiency_latest.index else None
        scoring_off = s["scoring_off"] if s is not None else None
        scoring_def = s["scoring_def"] if s is not None else None
        if team not in played_this_season and team in projected_by_team:
            scoring_off, scoring_def = projected_by_team[team]
        records.append(
            {
                "season": int(s["season"]) if s is not None else year,
                "week": int(s["week"]) if s is not None else 0,
                "team_id": team_id,
                "team": team,
                "classification": team_class.get(team_id),
                "scoring_off": scoring_off,
                "scoring_def": scoring_def,
                "overall": (scoring_off + scoring_def) if scoring_off is not None and scoring_def is not None else None,
                "efficiency_off": e["efficiency_off"] if e is not None else None,
                "efficiency_def": e["efficiency_def"] if e is not None else None,
            }
        )

    client = get_client()
    for i in range(0, len(records), 500):
        client.table("team_power_ratings").upsert(records[i : i + 500], on_conflict="team_id").execute()
    print(f"Upserted {len(records)} team power rating rows.")

    # Purge anything left over from before the fbs/fcs filtering above
    # existed (or a team that's since dropped out of the pool entirely) -
    # upsert alone never removes stale rows.
    current_ids = [r["team_id"] for r in records]
    if current_ids:
        stale = client.table("team_power_ratings").select("team_id").not_.in_("team_id", current_ids).execute()
        stale_ids = [r["team_id"] for r in stale.data]
        if stale_ids:
            client.table("team_power_ratings").delete().in_("team_id", stale_ids).execute()
            print(f"Purged {len(stale_ids)} stale rows no longer produced by this run.")


if __name__ == "__main__":
    run()
