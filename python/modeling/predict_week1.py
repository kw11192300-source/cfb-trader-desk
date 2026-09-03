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

# Quarter of full Kelly, not half - this is the model's first LIVE season
# (no track record yet, only backtest), several edge buckets have real but
# thin samples (27-44 games), and this project has already caught genuine
# modeling bugs more than once. Full/half Kelly assumes the win-rate
# estimate is trustworthy; quarter is the conservative-but-not-paranoid
# choice for an edge this fresh. Revisit once the P&L ledger has a real
# live track record (4-8+ weeks) to check the backtest against - loosen
# toward half-Kelly if live results track it, tighten further if they
# don't. One constant, deliberately easy to change later.
KELLY_FRACTION = 0.25
DEFAULT_ODDS = -110
MIN_SUGGESTED_UNITS = 0.5
MAX_SUGGESTED_UNITS = 3.0
UNIT_STEP = 0.5  # round the suggestion to a clean, bettor-usable increment - nobody bets 1.73 units


def _kelly_fraction(win_prob: float, odds: int = DEFAULT_ODDS) -> float:
    """Fraction of bankroll full Kelly would risk, for a bet at `odds`
    with true win probability `win_prob`. Negative if the "edge" implied
    by win_prob is actually below break-even at these odds - callers
    should floor this before using it as a stake."""
    decimal_odds = 100 / abs(odds) + 1 if odds < 0 else odds / 100 + 1
    b = decimal_odds - 1
    return win_prob - (1 - win_prob) / b


def _suggested_units(edge: float, edge_buckets: list[tuple[float, float, float, int]], reference_win_rate: float | None) -> float | None:
    """Quarter-Kelly stake, expressed as a MULTIPLE of "1 unit" rather than
    a fraction of an actual bankroll (never asked for or stored - see
    schema.sql's note on bets.stake). "1 unit" = the suggested size for a
    pick at the strategy's own OVERALL backtested win rate; a specific
    edge bucket that historically ran hotter or colder than that average
    scales proportionally, via the ratio of their quarter-Kelly fractions
    (a fixed reference avoids dividing by a near-zero Kelly fraction from
    whichever bucket happens to be weakest in a given run). Clamped to
    [MIN_SUGGESTED_UNITS, MAX_SUGGESTED_UNITS] so neither a marginal edge
    nor a hot-but-thin-sample bucket produces an extreme suggestion, then
    rounded to the nearest UNIT_STEP (0.5, 1, 1.5, ... 3) - a bettor-usable
    number, not a raw Kelly fraction nobody would actually stake.
    Returns None if there's no edge_bucket match or no reference rate."""
    if reference_win_rate is None:
        return None
    bucket = _edge_bucket_rate(edge, edge_buckets)
    if bucket is None:
        return None
    _, bucket_win_rate, _ = bucket

    reference_kelly = _kelly_fraction(reference_win_rate) * KELLY_FRACTION
    bucket_kelly = _kelly_fraction(bucket_win_rate) * KELLY_FRACTION
    if reference_kelly <= 0:
        return None  # reference itself isn't a real edge - sizing off it would be meaningless

    units = bucket_kelly / reference_kelly
    clamped = max(MIN_SUGGESTED_UNITS, min(MAX_SUGGESTED_UNITS, units))
    return round(clamped / UNIT_STEP) * UNIT_STEP


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


def _edge_bucket_rate(edge: float, buckets: list[tuple[float, float, float, int]]) -> tuple[str, float, int] | None:
    """buckets: sorted [(lo, hi, win_rate, n), ...] from model_backtests'
    edge_bucket rows. Returns (label, win_rate, n) for whichever bucket
    `edge` falls in, or None if edge is below the smallest bucket (the
    top-15-by-edge selection rarely reaches down that far anyway)."""
    for lo, hi, win_rate, n in buckets:
        if lo <= edge < hi:
            label = f"{lo:.0f}-{hi:.0f}" if hi != float("inf") else f"{lo:.0f}+"
            return label, win_rate, n
    return None


def _pick_spread_view(market_spread: float, predicted_margin: float, pick_home: bool) -> tuple[float, float]:
    """market_spread and predicted_margin, both from the PICKED team's own
    perspective and in the same spread convention (negative = favored) -
    same fix as the site's EdgesTable/BacktestGamesTable, so market − model
    == edge and the rationale's numbers match what's displayed. Kept
    separate from those (duplicated, not imported) since one's Python and
    one's TypeScript."""
    market = market_spread if pick_home else -market_spread
    model_spread = -predicted_margin
    model = model_spread if pick_home else -model_spread
    return market, model


def _build_rationale(
    pick_name: str,
    opp_name: str,
    pick_market: float,
    pick_model: float,
    pick_returning: float | None,
    opp_returning: float | None,
    pick_new_coach: bool,
    opp_new_coach: bool,
    pick_talent: float | None,
    opp_talent: float | None,
    pick_transfers: float | None,
    opp_transfers: float | None,
    edge: float,
    edge_buckets: list[tuple[float, float, float, int]],
) -> str:
    """Built entirely from the actual continuity/talent numbers that fed
    the model - not fabricated team scouting commentary. Cites a signal
    ONLY when it actually points toward the pick (pick_x - opp_x past the
    threshold) - never states a fact that favors the OPPONENT as if it
    were a reason to like the pick. Each signal has exactly one directional
    check, not a pair of "pick wins" / "opp wins" branches - a prior
    version had a second branch for "opp is weak" that was, mathematically,
    just the same comparison restated backwards, which produced exactly
    this bug: the 2023 Ohio State/Indiana game cited Ohio State's OWN
    higher returning production and higher talent as reasons to like
    Indiana, because that branch fired on any big gap regardless of which
    side it actually favored. Caught by a viewer noticing the cited
    reasoning pointed the opposite way from the actual pick. When none of
    these signals happen to support the pick, the model's edge is coming
    from something else entirely (usually the raw rating gap) and the
    fallback says exactly that, honestly, rather than manufacturing a
    reason."""
    parts = []

    if pick_returning is not None and opp_returning is not None and pick_returning - opp_returning >= 0.15:
        parts.append(f"{pick_name} returns {pick_returning * 100:.0f}% of last season's production vs. just {opp_returning * 100:.0f}% for {opp_name}")

    # A new coach isn't unambiguously bad (could be a real upgrade), so this
    # only cites it when it's on the OPPONENT's side, as a point of
    # uncertainty in the number being faded - not when the pick itself has
    # the new coach, which doesn't clearly argue for taking that side.
    if opp_new_coach and not pick_new_coach:
        parts.append(f"{opp_name} is breaking in a new head coach, a real source of preseason uncertainty the market may be underpricing")

    if pick_talent is not None and opp_talent is not None and pick_talent - opp_talent >= 60:
        parts.append(f"{pick_name} carries the higher recruiting/portal talent composite than {opp_name}")

    if pick_transfers is not None and opp_transfers is not None and pick_transfers - opp_transfers >= 15:
        parts.append(f"{pick_name} had the stronger transfer-portal haul this offseason")

    reason = "; and ".join(parts) if parts else "the model's own rating gap between these two teams, independent of any single continuity signal"
    market_str = f"{pick_market:+.1f}" if pick_market >= 0 else f"{pick_market:.1f}"
    model_str = f"{pick_model:+.1f}" if pick_model >= 0 else f"{pick_model:.1f}"
    sentence = (
        f"Market has {pick_name} at {market_str}; model has {pick_name} at {model_str} - a {edge:.1f}-point edge. "
        f"Favors {pick_name} largely because {reason}."
    )

    bucket = _edge_bucket_rate(edge, edge_buckets)
    if bucket:
        label, win_rate, n = bucket
        sentence += f" Edges of {label} points in this exact setup (week-1 FBS matchups) have covered {win_rate * 100:.0f}% of the time since 2016 (n={n})."
    return sentence


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

    coaching = _fetch_seasons("team_coaching", "season,team_id,is_new_coach", [year])
    new_coach_lookup = dict(zip(coaching["team_id"], coaching["is_new_coach"])) if not coaching.empty else {}

    # For compute_expanding_market_ratings/compute_expanding_results_ratings'
    # own week-1 continuity shrink (see market_rating.py) - same signals
    # already fetched above, just reshaped: returning needs its own column
    # (not buried in the stats JSONB), net transfers as a (season, team_id)
    # DataFrame rather than the flat lookup dict used elsewhere in this file.
    returning_for_mult = returning.copy()
    if not returning_for_mult.empty:
        returning_for_mult["returning_ppa_pct"] = returning_for_mult["stats"].apply(lambda s: s.get("percentPPA") if isinstance(s, dict) else None)
    net_transfer_stars_df = pd.DataFrame(columns=["season", "team_id", "net_transfer_stars"])
    if not transfers.empty:
        immediate = transfers[transfers["eligibility"] == "Immediate"].copy()
        incoming = immediate.dropna(subset=["destination_team_id"]).groupby(["season", "destination_team_id"])["stars"].sum()
        outgoing = immediate.dropna(subset=["origin_team_id"]).groupby(["season", "origin_team_id"])["stars"].sum()
        incoming.index.names = outgoing.index.names = ["season", "team_id"]
        net_transfer_stars_df = incoming.sub(outgoing, fill_value=0).reset_index(name="net_transfer_stars")
    id_to_name = dict(zip(games["home_id"], games["home_team"]))
    id_to_name.update(dict(zip(games["away_id"], games["away_team"])))
    from .features import build_continuity_multipliers  # local import - avoid circular concerns at module load

    continuity_multipliers = build_continuity_multipliers([year], returning_for_mult, net_transfer_stars_df, coaching, id_to_name)
    fbs_teams = set(games["home_team"]) | set(games["away_team"])  # this script is already FBS-vs-FBS only

    edge_bucket_rows = fetch_all("model_backtests", "label,n,win_rate", model_version=MODEL_VERSION, group_key="edge_bucket")
    edge_buckets: list[tuple[float, float, float, int]] = []
    for r in edge_bucket_rows:
        lo_str, _, hi_str = r["label"].partition("-")
        lo = float(lo_str.rstrip("+"))
        hi = float(hi_str) if hi_str else float("inf")
        edge_buckets.append((lo, hi, r["win_rate"], r["n"]))
    edge_buckets.sort()

    matchup_type_rows = fetch_all("model_backtests", "label,win_rate", model_version=MODEL_VERSION, group_key="matchup_type")
    reference_win_rate = next((r["win_rate"] for r in matchup_type_rows if r["label"] == "fbs_vs_fbs"), None)

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
                    spread_input[["season", "week", "home_team", "away_team", "spread", "neutral_site"]],
                    continuity_multipliers,
                    fbs_teams,
                )
                if not mr.empty:
                    market_rating_lookup = mr.sort_values(["season", "week"]).drop_duplicates("team", keep="last").set_index("team")["market_rating"].to_dict()
        results_input = hist_games.dropna(subset=["home_points", "away_points"]).copy()
        results_input["actual_margin"] = results_input["home_points"] - results_input["away_points"]
        rr = compute_expanding_results_ratings(
            results_input[["season", "week", "home_team", "away_team", "actual_margin", "neutral_site"]], continuity_multipliers, fbs_teams
        )
        if not rr.empty:
            results_rating_lookup = rr.sort_values(["season", "week"]).drop_duplicates("team", keep="last").set_index("team")["results_rating"].to_dict()

    # The walk-forward calls above only ever fit hist_seasons (year-10..year-1)
    # - their own internal week-1 shrink never gets to see THIS season's
    # continuity data, since `year` never appears in that walk. What we took
    # is each team's raw last-season-final value, exactly the same gap
    # power_rating.py had before its fix. Apply the same shrink directly to
    # the resulting lookups using this season's own continuity multipliers.
    from .market_rating import _shrink_to_mean  # local import - internal reuse, same package

    market_rating_lookup = _shrink_to_mean(market_rating_lookup, fbs_teams, {t: continuity_multipliers.get((year, t), 1.0) for t in market_rating_lookup})
    results_rating_lookup = _shrink_to_mean(results_rating_lookup, fbs_teams, {t: continuity_multipliers.get((year, t), 1.0) for t in results_rating_lookup})

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
            "new_coach": bool(new_coach_lookup.get(team_id, False)),
        }

    rows = []
    team_feats: dict[int, tuple[dict, dict]] = {}  # game_id -> (home_feat, away_feat), reused when building rationale
    for g in games.itertuples():
        home = feat(g.home_id, g.home_team, g.home_conference)
        away = feat(g.away_id, g.away_team, g.away_conference)
        team_feats[g.id] = (home, away)
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
        pick_home = r["edge"] > 0
        pick_market, pick_model = _pick_spread_view(r["market_spread"], r["predicted_margin"], pick_home)
        print(
            f"{r['away_team']:22s} @ {r['home_team']:22s}  pick={r['pick']:20s} "
            f"market={pick_market:+6.1f}  model={pick_model:+6.1f}  edge={abs(r['edge']):5.1f}"
        )

    records = []
    for _, r in feat_df.iterrows():
        home_f, away_f = team_feats[r["game_id"]]
        pick_home = r["edge"] > 0
        pick_f, opp_f = (home_f, away_f) if pick_home else (away_f, home_f)
        pick_name, opp_name = (r["home_team"], r["away_team"]) if pick_home else (r["away_team"], r["home_team"])
        pick_mkt, pick_mdl = _pick_spread_view(r["market_spread"], r["predicted_margin"], pick_home)
        rationale = _build_rationale(
            pick_name, opp_name, pick_mkt, pick_mdl,
            pick_f["returning_ppa_pct"], opp_f["returning_ppa_pct"],
            pick_f["new_coach"], opp_f["new_coach"],
            pick_f["talent"], opp_f["talent"],
            pick_f["net_transfer_stars"], opp_f["net_transfer_stars"],
            abs(r["edge"]), edge_buckets,
        )
        suggested_units = _suggested_units(abs(r["edge"]), edge_buckets, reference_win_rate)
        records.append(
            {
                "game_id": int(r["game_id"]),
                "model_version": MODEL_VERSION,
                "predicted_margin": float(r["predicted_margin"]),
                "market_spread": float(r["market_spread"]),
                "edge_spread": float(r["edge"]),
                "rationale": rationale,
                "suggested_units": suggested_units,
            }
        )
    for i in range(0, len(records), 500):
        client.table("predictions").upsert(records[i : i + 500], on_conflict="game_id,model_version").execute()
    print(f"\nUpserted {len(records)} predictions (model_version={MODEL_VERSION}).")

    # Telegram alerts for newly-appeared top-N picks - no-ops cleanly if
    # TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set. See alerts/telegram_alerts.py
    # for why this is scoped to the top-N pool specifically (the one
    # validated signal), not a broader/looser notion of "interesting edge."
    from alerts.telegram_alerts import send_new_edge_alerts

    top_game_ids = {int(gid) for gid in ranked.head(TOP_N)["game_id"]}
    n_alerted = send_new_edge_alerts(client, MODEL_VERSION, records, top_game_ids)
    if n_alerted:
        print(f"Sent {n_alerted} new Telegram edge alert(s).")


if __name__ == "__main__":
    run()
