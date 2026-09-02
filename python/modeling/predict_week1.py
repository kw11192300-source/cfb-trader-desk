"""
Live week-1 edge finder — the scoped, validated version of the "predict
which lines to bet" goal, NOT the general in-season serving system (that's
still future work, see predict_week.py in the original plan).

Backtest finding this is built on (2016-2025, walk-forward): betting the
model's margin prediction against the market's current spread, on true
week-1-of-season FBS-vs-FBS games only (both teams at 0 games played this
season - i.e. genuinely no in-season evidence yet, still on the preseason
projection), restricted to the top ~15 highest-edge games per week by
|predicted_margin - market_implied_margin|, hit 74.0% ATS across 150 games
2016-2024 and held (80%) on the one fully out-of-sample season (2025).
Checked for trivial bias (always-favorite/always-dog/always-home/away) -
none found, roughly balanced with near-identical win rates each way.
Buy games (FBS vs FCS) and FCS-vs-FCS games showed NO edge in isolation
when tested separately - deliberately excluded here, not an oversight.

Does NOT need in-season cumulative stats (PPA, points scored/allowed,
turnover margin, etc.) - by definition these are all still NaN at 0 games
played, same as how week-1 rows already look in the historical training
data. Everything else is genuinely available before kickoff:
  - scoring_off/def, efficiency_off/def: read straight from
    team_power_ratings (the live snapshot - already the learned
    preseason-projection model for scoring, see sync_power_ratings.py).
  - elo/SP+/SRS: last available prior-season entry per team.
  - talent/returning production/coaching/transfers: current-season tables
    (all preseason-published, safe).
  - market_rating/results_rating: last value from market_rating.py's
    expanding fit through the most recently completed season - the
    carried-forward prior for the new season, same convention as
    power_rating.py's own preseason snapshot.

Usage:
    python -m modeling.predict_week1
"""
from __future__ import annotations

import datetime

import pandas as pd

from cfbd_ingest.supabase_client import fetch_all, get_client

from .features import (
    BOOK_PREFERENCE,
    POWER_CONFERENCES,
    _fetch_seasons,
    build_training_dataset,
)
from .market_rating import compute_expanding_market_ratings, compute_expanding_results_ratings
from .outcome_models import FEATURE_COLUMNS, train_margin_model

MODEL_VERSION = "week1_edge_v1"
TOP_N = 15


def _current_market_line(game_ids: list[int]) -> dict[int, float]:
    """Freshest captured spread per game, preferring the same book order
    used everywhere else in this project. Uses the CURRENT (not
    necessarily open) number - a real bettor bets whatever's on the board
    right now, not the eventual close."""
    client = get_client()
    rows = client.table("betting_lines").select("game_id,provider,spread,fetched_at").in_("game_id", game_ids).execute().data
    if not rows:
        return {}
    df = pd.DataFrame(rows).dropna(subset=["spread"])
    if df.empty:
        return {}
    df["book_rank"] = df["provider"].apply(lambda p: BOOK_PREFERENCE.index(p) if p in BOOK_PREFERENCE else len(BOOK_PREFERENCE))
    df = df.sort_values(["game_id", "book_rank", "fetched_at"], ascending=[True, True, False])
    best = df.drop_duplicates("game_id", keep="first")
    return dict(zip(best["game_id"], best["spread"]))


def _latest_prior_rating(source: str, before_season: int) -> dict[int, float]:
    """Most recent week=0 (season-final) rating per team, from the most
    recent season strictly before `before_season` that has one - handles
    a team whose most recent SP+/SRS entry might be a year or two back."""
    rows = fetch_all("team_ratings", "season,week,team_id,rating,source", source=source, week=0)
    if not rows:
        return {}
    df = pd.DataFrame(rows)
    df = df[df["season"] < before_season]
    if df.empty:
        return {}
    df["value"] = df["rating"].apply(lambda r: r.get("rating") if isinstance(r, dict) else None)
    df = df.dropna(subset=["value"]).sort_values("season")
    return df.drop_duplicates("team_id", keep="last").set_index("team_id")["value"].to_dict()


def _latest_elo(before_season: int) -> dict[int, float]:
    rows = fetch_all("team_ratings", "season,week,team_id,rating,source", source="elo")
    if not rows:
        return {}
    df = pd.DataFrame(rows)
    df = df[df["season"] < before_season]
    if df.empty:
        return {}
    df["value"] = df["rating"].apply(lambda r: r.get("elo") if isinstance(r, dict) else None)
    df = df.dropna(subset=["value"]).sort_values(["season", "week"])
    return df.drop_duplicates("team_id", keep="last").set_index("team_id")["value"].to_dict()


def run() -> None:
    year = datetime.date.today().year
    print(f"Finding week-1 edges for {year}...")

    client = get_client()
    games = client.table("games").select(
        "id,season,week,season_type,start_date,neutral_site,home_id,home_team,home_conference,away_id,away_team,away_conference"
    ).eq("season", year).eq("week", 1).eq("season_type", "regular").eq("completed", False).execute().data
    games = pd.DataFrame(games)
    if games.empty:
        print("No upcoming week-1 games found - already past week 1, or games table not yet synced for this week.")
        return

    team_class = {t["id"]: t["classification"] for t in fetch_all("teams", "id,classification")}
    games["home_classification"] = games["home_id"].map(team_class)
    games["away_classification"] = games["away_id"].map(team_class)
    games = games[(games["home_classification"] == "fbs") & (games["away_classification"] == "fbs")].copy()
    if games.empty:
        print("No FBS-vs-FBS week-1 games found.")
        return
    print(f"{len(games)} FBS-vs-FBS week-1 games found.")

    market = _current_market_line(games["id"].tolist())
    games = games[games["id"].isin(market.keys())].copy()
    if games.empty:
        print("None of this week's FBS games have a market line posted yet - try again closer to kickoff.")
        return
    games["market_spread"] = games["id"].map(market)

    print("Loading team ratings (power ratings, prior SP+/SRS/Elo, talent/continuity)...")
    power = pd.DataFrame(fetch_all("team_power_ratings", "team_id,scoring_off,scoring_def,efficiency_off,efficiency_def"))
    power_lookup = power.set_index("team_id").to_dict("index") if not power.empty else {}

    sp_prior = _latest_prior_rating("sp_plus", year)
    srs_prior = _latest_prior_rating("srs", year)
    elo_prior = _latest_elo(year)

    talent = _fetch_seasons("team_talent", "season,team_id,talent", [year])
    talent_lookup = dict(zip(talent["team_id"], talent["talent"])) if not talent.empty else {}

    returning = _fetch_seasons("team_returning_production", "season,team_id,stats", [year])
    returning_lookup = {}
    if not returning.empty:
        for _, r in returning.iterrows():
            stats = r["stats"] if isinstance(r["stats"], dict) else {}
            returning_lookup[r["team_id"]] = stats.get("percentPPA")

    transfers = _fetch_seasons("player_transfers", "season,origin_team_id,destination_team_id,stars,eligibility", [year])
    net_transfer_lookup: dict[int, float] = {}
    if not transfers.empty:
        immediate = transfers[transfers["eligibility"] == "Immediate"].copy()
        incoming = immediate.dropna(subset=["destination_team_id"]).groupby("destination_team_id")["stars"].sum()
        outgoing = immediate.dropna(subset=["origin_team_id"]).groupby("origin_team_id")["stars"].sum()
        net_transfer_lookup = incoming.sub(outgoing, fill_value=0).to_dict()

    print("Computing carried-forward market/results ratings (through last completed season)...")
    hist_seasons = list(range(year - 10, year))
    from .features import _load_games  # local import - avoid circular concerns at module load

    hist_games = _load_games(hist_seasons)
    lines_hist = pd.DataFrame(fetch_all("betting_lines", "game_id,provider,spread")) if not hist_games.empty else pd.DataFrame()
    market_rating_lookup: dict[str, float] = {}
    results_rating_lookup: dict[str, float] = {}
    if not hist_games.empty:
        if not lines_hist.empty:
            best_line = lines_hist.sort_values("provider").drop_duplicates("game_id")
            spread_input = hist_games.merge(best_line, left_on="id", right_on="game_id", how="left")
            spread_input = spread_input.dropna(subset=["spread"])
            if not spread_input.empty:
                mr = compute_expanding_market_ratings(
                    spread_input[["season", "week", "home_team", "away_team", "spread", "neutral_site"]]
                )
                if not mr.empty:
                    market_rating_lookup = mr.sort_values(["season", "week"]).drop_duplicates("team", keep="last").set_index("team")["market_rating"].to_dict()
        results_input = hist_games.dropna(subset=["home_points", "away_points"]).copy()
        results_input["actual_margin"] = results_input["home_points"] - results_input["away_points"]
        rr = compute_expanding_results_ratings(results_input[["season", "week", "home_team", "away_team", "actual_margin", "neutral_site"]])
        if not rr.empty:
            results_rating_lookup = rr.sort_values(["season", "week"]).drop_duplicates("team", keep="last").set_index("team")["results_rating"].to_dict()

    print("Training margin model on all completed seasons through last year...")
    train_df = build_training_dataset(list(range(year - 11, year)))
    model = train_margin_model(train_df)

    def feat(team_id: int, team_name: str, conference: str | None) -> dict:
        p = power_lookup.get(team_id, {})
        return {
            "power_conf": conference in POWER_CONFERENCES,
            "is_fbs": True,
            "prior_srs": srs_prior.get(team_id),
            "prior_sp_plus": sp_prior.get(team_id),
            "talent": talent_lookup.get(team_id),
            "returning_ppa_pct": returning_lookup.get(team_id),
            "net_transfer_stars": net_transfer_lookup.get(team_id, 0),
            "market_rating": market_rating_lookup.get(team_name),
            "results_rating": results_rating_lookup.get(team_name),
            "scoring_off": p.get("scoring_off"),
            "scoring_def": p.get("scoring_def"),
            "efficiency_off": p.get("efficiency_off"),
            "efficiency_def": p.get("efficiency_def"),
        }

    rows = []
    for g in games.itertuples():
        home = feat(g.home_id, g.home_team, g.home_conference)
        away = feat(g.away_id, g.away_team, g.away_conference)
        row = {
            "game_id": g.id,
            "home_team": g.home_team,
            "away_team": g.away_team,
            "neutral_site": g.neutral_site,
            "conference_game": g.home_conference == g.away_conference,
            "home_power_conf": home["power_conf"],
            "away_power_conf": away["power_conf"],
            "home_is_fbs": True,
            "away_is_fbs": True,
            "is_cross_division": False,
            "elo_diff": (elo_prior.get(g.home_id) - elo_prior.get(g.away_id)) if elo_prior.get(g.home_id) is not None and elo_prior.get(g.away_id) is not None else None,
            "home_prior_srs": home["prior_srs"],
            "away_prior_srs": away["prior_srs"],
            "home_cum_points_scored": None, "home_cum_points_allowed": None,
            "away_cum_points_scored": None, "away_cum_points_allowed": None,
            "home_games_played": 0, "away_games_played": 0,
            "home_cum_turnover_margin": None, "away_cum_turnover_margin": None,
            "home_cum_possession_seconds": None, "away_cum_possession_seconds": None,
            "home_cum_third_down_pct": None, "away_cum_third_down_pct": None,
            "home_cum_penalty_yards": None, "away_cum_penalty_yards": None,
            "home_prior_sp_plus": home["prior_sp_plus"], "away_prior_sp_plus": away["prior_sp_plus"],
            "home_talent": home["talent"], "away_talent": away["talent"],
            "home_returning_ppa_pct": home["returning_ppa_pct"], "away_returning_ppa_pct": away["returning_ppa_pct"],
            "home_net_transfer_stars": home["net_transfer_stars"], "away_net_transfer_stars": away["net_transfer_stars"],
            "home_market_rating": home["market_rating"], "away_market_rating": away["market_rating"],
            "home_results_rating": home["results_rating"], "away_results_rating": away["results_rating"],
            "home_scoring_off": home["scoring_off"], "home_scoring_def": home["scoring_def"],
            "away_scoring_off": away["scoring_off"], "away_scoring_def": away["scoring_def"],
            "home_efficiency_off": home["efficiency_off"], "home_efficiency_def": home["efficiency_def"],
            "away_efficiency_off": away["efficiency_off"], "away_efficiency_def": away["efficiency_def"],
        }
        for c in FEATURE_COLUMNS:
            if c.startswith("home_cum_") or c.startswith("away_cum_"):
                row.setdefault(c, None)  # PPA-derived cum stats - all NaN at 0 games played
        rows.append(row)

    feat_df = pd.DataFrame(rows)
    X = feat_df[FEATURE_COLUMNS].astype(float)
    feat_df["predicted_margin"] = model.predict(X)
    feat_df["market_spread"] = games.set_index("id").loc[feat_df["game_id"], "market_spread"].to_numpy()
    feat_df["market_implied_margin"] = -feat_df["market_spread"]
    feat_df["edge"] = feat_df["predicted_margin"] - feat_df["market_implied_margin"]
    feat_df["pick"] = feat_df.apply(lambda r: r["home_team"] if r["edge"] > 0 else r["away_team"], axis=1)

    ranked = feat_df.reindex(feat_df["edge"].abs().sort_values(ascending=False).index)

    print(f"\n=== Top {TOP_N} week-1 edges (FBS vs FBS only) ===")
    for _, r in ranked.head(TOP_N).iterrows():
        print(
            f"{r['away_team']:22s} @ {r['home_team']:22s}  market={r['market_spread']:+6.1f}  "
            f"model={r['predicted_margin']:+6.1f}  edge={abs(r['edge']):5.1f}  pick={r['pick']}"
        )

    records = []
    for _, r in feat_df.iterrows():
        records.append(
            {
                "game_id": int(r["game_id"]),
                "model_version": MODEL_VERSION,
                "predicted_margin": float(r["predicted_margin"]),
                "market_spread": float(r["market_spread"]),
                "edge_spread": float(r["edge"]),
            }
        )
    for i in range(0, len(records), 500):
        client.table("predictions").upsert(records[i : i + 500], on_conflict="game_id,model_version").execute()
    print(f"\nUpserted {len(records)} predictions (model_version={MODEL_VERSION}).")


if __name__ == "__main__":
    run()
