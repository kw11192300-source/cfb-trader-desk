"""
Builds a point-in-time-safe training dataset: one row per historical game,
with every feature computed from data that was genuinely available before
that game was played. See the modeling plan (or market_rating.py's and
backfill_weekly_elo.py's docstrings) for why this matters and which sources
are safe to use how.

Feature groups:
  - Elo differential (home - away), as of the most recent week strictly
    before the game, from team_ratings(source='elo') — now populated with
    real weekly history (see backfill_weekly_elo.py).
  - Cumulative in-season performance (PPA/success rate/explosiveness,
    offense & defense), computed from team_game_stats rows strictly before
    the game's own date within that season.
  - Prior-season SP+ final rating — safe because it's fully determined
    before the season starts (CFBD's SP+ doesn't vary by week at all, so
    *current*-season SP+ would leak; prior-season doesn't).
  - Team talent composite and returning-production % for the CURRENT
    season — both are preseason-published numbers (recruiting/roster
    composition known before kickoff), safe as direct current-season
    features unlike SP+/Elo/stats.
  - Net transfer-portal talent (incoming minus outgoing blue-chip stars,
    'Immediate' eligibility only — the ones who'll actually play this
    season) for the current season.
  - Market-implied power rating (market_rating.py) — the smoothed,
    already-closed-games-only signal, not the target game's own line.
  - Targets: actual_margin, actual_total, home_win, spread_move, total_move.
"""
from __future__ import annotations

import pandas as pd

from cfbd_ingest.supabase_client import fetch_all, get_client

from .market_rating import compute_expanding_market_ratings, compute_expanding_results_ratings
from .power_rating import compute_expanding_efficiency_ratings, compute_expanding_scoring_ratings

MODEL_PROJECTIONS = {"numberfire", "teamrankings"}
# Bovada matters here specifically because it's the book with by far the best
# historical spread_open coverage (2021-2024) once DraftKings isn't present
# in older seasons - see the bug this fixed in _pick_market_line's docstring.
BOOK_PREFERENCE = ["DraftKings", "Bovada", "consensus"]

# PPA-derived per-game advanced stats (team_game_stats) worth carrying as
# cumulative pregame features - "cum_" prefix added by _cumulative_pregame_stats,
# "home_"/"away_" prefix added when assembling each game's row.
PPA_STAT_COLS = [
    "off_ppa", "off_success_rate", "off_explosiveness", "off_plays",
    "off_power_success", "off_stuff_rate", "off_line_yards", "off_standard_downs_sr", "off_passing_downs_sr",
    "def_ppa", "def_success_rate", "def_explosiveness",
    "def_power_success", "def_stuff_rate", "def_line_yards", "def_standard_downs_sr", "def_passing_downs_sr",
]  # fmt: skip


def _fetch_seasons(table: str, select: str, seasons: list[int]) -> pd.DataFrame:
    rows: list[dict] = []
    for season in seasons:
        rows.extend(fetch_all(table, select, season=season))
    return pd.DataFrame(rows)


def _fetch_by_game_ids(table: str, select: str, game_ids: list[int]) -> pd.DataFrame:
    client = get_client()
    rows: list[dict] = []
    for i in range(0, len(game_ids), 500):
        batch = game_ids[i : i + 500]
        rows.extend(client.table(table).select(select).in_("game_id", batch).execute().data)
    return pd.DataFrame(rows)


# Covers the "Power" conferences across the full 2015-2026 window, including
# ones that no longer exist as such (Pac-12 was a power conference through
# 2023, before realignment folded most of its members elsewhere) - each
# game's own home_conference/away_conference is season-specific already, so
# this only needs to be a lookup table, not year-aware itself.
POWER_CONFERENCES = {"SEC", "Big Ten", "Big 12", "ACC", "Pac-12", "Pac-10"}


def _load_games(seasons: list[int]) -> pd.DataFrame:
    df = _fetch_seasons(
        "games",
        "id,season,week,season_type,start_date,completed,neutral_site,home_id,home_team,home_conference,home_points,away_id,away_team,away_conference,away_points",
        seasons,
    )
    if df.empty:
        return df
    df = df[df["completed"]].copy()
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["home_power_conf"] = df["home_conference"].isin(POWER_CONFERENCES)
    df["away_power_conf"] = df["away_conference"].isin(POWER_CONFERENCES)
    df["conference_game"] = df["home_conference"] == df["away_conference"]

    # games now includes FCS-vs-FCS games too (backfill_fcs.py) alongside
    # the original FBS-only pull - tag each side's division so callers can
    # segment or filter by it, and so FBS-vs-FCS "buy games" (a genuinely
    # different animal - huge, predictable mismatches) are distinguishable
    # from same-division matchups.
    team_class = pd.DataFrame(fetch_all("teams", "id,classification"))
    class_map = dict(zip(team_class["id"], team_class["classification"]))
    df["home_classification"] = df["home_id"].map(class_map)
    df["away_classification"] = df["away_id"].map(class_map)
    df["is_cross_division"] = (df["home_classification"] == "fbs") != (df["away_classification"] == "fbs")

    # FCS teams occasionally schedule a D2/D3/unclassified opponent (or
    # CFBD's classification=fcs filter pulls one in - see backfill_fcs.py's
    # note that CFBD's classification param isn't fully reliable). Those
    # games have no business in an FBS/FCS rating or model: drop anything
    # where either side isn't actually fbs or fcs.
    valid_class = {"fbs", "fcs"}
    df = df[df["home_classification"].isin(valid_class) & df["away_classification"].isin(valid_class)].copy()
    return df


def _pick_market_line(lines: pd.DataFrame) -> pd.DataFrame:
    """One row per game_id: prefers whichever book actually HAS a
    spread_open (needed for the movement target), in BOOK_PREFERENCE order
    among those; only falls back to "any book, open or not" when literally
    no provider has open data for that game (true for essentially every
    game before 2021 — a real CFBD historical gap, not a selection issue).

    Earlier version checked `x is not None` instead of `pd.notna(x)` -
    pandas silently turns SQL NULL into NaN on load, and `NaN is not None`
    is True, so that check treated "no open data" as "has open data" and
    kept whatever book BOOK_PREFERENCE hit first even when it was exactly
    the book missing the open line — caught by comparing this function's
    season-by-season coverage against a direct groupby on the raw table,
    which showed 2021 alone should have ~493 games with a real open line
    (all via Bovada) that were coming out as missing.
    """
    if lines.empty:
        return lines
    lines = lines[~lines["provider"].str.lower().isin(MODEL_PROJECTIONS)]

    def choose(group: pd.DataFrame) -> pd.Series:
        with_open = group[group["spread_open"].notna()]
        pool = with_open if not with_open.empty else group
        for book in BOOK_PREFERENCE:
            match = pool[pool["provider"] == book]
            if not match.empty:
                return match.iloc[0]
        return pool.iloc[0]

    return lines.groupby("game_id", group_keys=False).apply(choose, include_groups=False).reset_index()


def _load_market_lines(game_ids: list[int]) -> pd.DataFrame:
    raw = _fetch_by_game_ids(
        "betting_lines", "game_id,provider,spread,spread_open,over_under,over_under_open,home_moneyline,away_moneyline", game_ids
    )
    return _pick_market_line(raw)


def _load_team_game_stats(game_ids: list[int]) -> pd.DataFrame:
    # team_game_stats has no season column of its own (keyed by game_id) -
    # filter by the game ids we already loaded instead of season=.
    raw = _fetch_by_game_ids("team_game_stats", "game_id,team_id,team,stats", game_ids)
    if raw.empty:
        return raw
    rows = []
    for r in raw.itertuples():
        off, dfn = r.stats.get("offense", {}), r.stats.get("defense", {})
        off_std, off_pass = off.get("standardDowns", {}), off.get("passingDowns", {})
        dfn_std, dfn_pass = dfn.get("standardDowns", {}), dfn.get("passingDowns", {})
        rows.append(
            {
                "game_id": r.game_id,
                "team_id": r.team_id,
                "team": r.team,
                "off_ppa": off.get("ppa"),
                "off_success_rate": off.get("successRate"),
                "off_explosiveness": off.get("explosiveness"),
                "off_plays": off.get("plays"),  # pace proxy - PPA/success rate alone say nothing about how many
                "off_power_success": off.get("powerSuccess"),  # short-yardage conversion rate
                "off_stuff_rate": off.get("stuffRate"),  # run plays stopped at/behind the line
                "off_line_yards": off.get("lineYards"),  # run-blocking-specific yardage metric
                "off_standard_downs_sr": off_std.get("successRate"),  # 1st/early-2nd down efficiency
                "off_passing_downs_sr": off_pass.get("successRate"),  # obvious-passing-situation efficiency
                "def_ppa": dfn.get("ppa"),  # possessions a team gets, which totals depend on heavily
                "def_success_rate": dfn.get("successRate"),
                "def_explosiveness": dfn.get("explosiveness"),
                "def_power_success": dfn.get("powerSuccess"),  # opponent's short-yardage success allowed
                "def_stuff_rate": dfn.get("stuffRate"),  # run stops for loss/no gain forced
                "def_line_yards": dfn.get("lineYards"),
                "def_standard_downs_sr": dfn_std.get("successRate"),
                "def_passing_downs_sr": dfn_pass.get("successRate"),
            }
        )
    return pd.DataFrame(rows)


def _load_boxscore(game_ids: list[int]) -> pd.DataFrame:
    """Raw per-game box score, with each team's TAKEAWAYS derived by
    joining to its opponent's own turnovers row in the same game (CFBD
    gives giveaways per team, not takeaways forced - takeaways = the other
    team's giveaways). Turnover MARGIN (takeaways - giveaways) is the
    classically predictive combination, not giveaways alone."""
    raw = _fetch_by_game_ids(
        "team_game_boxscore", "game_id,team_id,team,stats", game_ids
    )
    if raw.empty:
        return raw
    raw = raw.copy()
    for col in ["turnovers", "possession_seconds", "third_down_made", "third_down_attempted", "penalty_yards"]:
        raw[col] = raw["stats"].apply(lambda s, c=col: s.get(c))

    # Opponent's turnovers, per game: for a 2-row-per-game table, each row's
    # takeaways = sum of turnovers among the OTHER row(s) in that game_id.
    game_totals = raw.groupby("game_id")["turnovers"].transform("sum")
    raw["takeaways"] = game_totals - raw["turnovers"]
    raw["turnover_margin"] = raw["takeaways"] - raw["turnovers"]

    return raw[["game_id", "team_id", "turnover_margin", "possession_seconds", "third_down_made", "third_down_attempted", "penalty_yards"]]


def _cumulative_boxscore(games: pd.DataFrame, boxscore: pd.DataFrame) -> pd.DataFrame:
    """Same strictly-prior-games-only rule as _cumulative_pregame_stats.
    Third-down % uses expanding SUM of made/attempted (not a mean of
    per-game percentages) to avoid small-sample distortion early season."""
    merged = boxscore.merge(games[["id", "season", "start_date"]], left_on="game_id", right_on="id")
    merged = merged.sort_values(["season", "team_id", "start_date"])
    grouped = merged.groupby(["season", "team_id"], group_keys=False)
    for col in ["turnover_margin", "possession_seconds", "penalty_yards"]:
        merged[f"cum_{col}"] = grouped[col].apply(lambda s: s.shift(1).expanding().mean())
    made_cum = grouped["third_down_made"].apply(lambda s: s.shift(1).expanding().sum())
    att_cum = grouped["third_down_attempted"].apply(lambda s: s.shift(1).expanding().sum())
    merged["cum_third_down_pct"] = made_cum / att_cum.replace(0, float("nan"))
    return merged[["game_id", "team_id", "cum_turnover_margin", "cum_possession_seconds", "cum_penalty_yards", "cum_third_down_pct"]]


def _cumulative_pregame_stats(games: pd.DataFrame, game_stats: pd.DataFrame) -> pd.DataFrame:
    """For each (season, team, game), the mean of that team's own
    team_game_stats from STRICTLY EARLIER games in that season (shift(1)
    before the expanding mean — the game itself is never included)."""
    stat_cols = PPA_STAT_COLS
    merged = game_stats.merge(games[["id", "season", "start_date"]], left_on="game_id", right_on="id")
    merged = merged.sort_values(["season", "team_id", "start_date"])
    grouped = merged.groupby(["season", "team_id"], group_keys=False)
    for col in stat_cols:
        merged[f"cum_{col}"] = grouped[col].apply(lambda s: s.shift(1).expanding().mean())
    return merged[["game_id", "team_id"] + [f"cum_{c}" for c in stat_cols]]


def _cumulative_scoring(games: pd.DataFrame) -> pd.DataFrame:
    """Cumulative points-scored/points-allowed per (season, team), same
    strictly-prior-games-only rule as _cumulative_pregame_stats. Direct
    scoring averages the total model was missing entirely - PPA/success
    rate capture efficiency, not how many points actually go on the board,
    which is what a total bet is literally about."""
    home = games[["id", "season", "start_date", "home_id", "home_points", "away_points"]].rename(
        columns={"home_id": "team_id", "home_points": "points_scored", "away_points": "points_allowed"}
    )
    away = games[["id", "season", "start_date", "away_id", "away_points", "home_points"]].rename(
        columns={"away_id": "team_id", "away_points": "points_scored", "home_points": "points_allowed"}
    )
    long = pd.concat([home, away], ignore_index=True).sort_values(["season", "team_id", "start_date"])
    grouped = long.groupby(["season", "team_id"], group_keys=False)
    long["cum_points_scored"] = grouped["points_scored"].apply(lambda s: s.shift(1).expanding().mean())
    long["cum_points_allowed"] = grouped["points_allowed"].apply(lambda s: s.shift(1).expanding().mean())
    # How many games (strictly before this one) this team has already played
    # THIS season - a confidence proxy for every rating feature derived from
    # in-season data (scoring/efficiency off-def, market/results ratings):
    # 0 means those ratings are still entirely the preseason projection/
    # prior, not backed by any real evidence from this season yet. See
    # outcome_models.py/movement_model.py FEATURE_COLUMNS.
    long["cum_games_played"] = long.groupby(["season", "team_id"]).cumcount()
    return long[["id", "team_id", "cum_points_scored", "cum_points_allowed", "cum_games_played"]].rename(columns={"id": "game_id"})


def build_continuity_multipliers(
    seasons: list[int],
    returning: pd.DataFrame,
    net_transfer_stars: pd.DataFrame,
    coaching: pd.DataFrame,
    id_to_name: dict[int, str],
) -> dict[tuple[int, str], float]:
    """{(season, team_name): multiplier} for the power-rating prior weight
    - how much a team's PRIOR-season rating should be trusted heading into
    `season`. Combines three continuity signals, each scaled to be ~1.0 at
    a "typical" team and pulling toward 0 the less continuity there is:
      - returning production %: 0.4 (nothing returning) to 1.6 (everything
        returning), linear, ~1.0 around the ~50% that's typical.
      - new head coach: flat 0.6x penalty - a real disruption regardless
        of roster continuity.
      - net transfer-portal stars: modest +/-30% based on net blue-chip
        talent gained/lost (the sign of a MAJOR overhaul beyond what
        returning-production alone captures).
    Clipped to [0.2, 2.0] to avoid pathological weights from any one
    extreme signal. Missing data for a team defaults its component to 1.0
    (no adjustment) rather than penalizing for lack of data.
    """
    returning_map = {(row["season"], row["team_id"]): row["returning_ppa_pct"] for _, row in returning.iterrows()} if not returning.empty else {}
    transfer_map = (
        {(row["season"], row["team_id"]): row["net_transfer_stars"] for _, row in net_transfer_stars.iterrows()} if not net_transfer_stars.empty else {}
    )
    coaching_map = {(row["season"], row["team_id"]): row["is_new_coach"] for _, row in coaching.iterrows()} if not coaching.empty else {}

    all_keys = set(returning_map.keys()) | set(transfer_map.keys()) | set(coaching_map.keys())
    out: dict[tuple[int, str], float] = {}
    for season, team_id in all_keys:
        if season not in seasons or team_id not in id_to_name:
            continue
        mult = 1.0
        rp = returning_map.get((season, team_id))
        if rp is not None:
            mult *= max(0.4, min(1.6, 0.4 + 1.2 * rp))
        if coaching_map.get((season, team_id)):
            mult *= 0.6
        nts = transfer_map.get((season, team_id))
        if nts is not None:
            mult *= max(0.7, min(1.3, 1 + nts / 50))
        out[(season, id_to_name[team_id])] = max(0.2, min(2.0, mult))
    return out


def _asof_elo(elo_df: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Elo as of the most recent rated week strictly before each game's own
    week, per (season, team)."""
    if elo_df.empty:
        return pd.DataFrame(columns=["game_id", "team_id", "elo"])
    elo_df = elo_df.copy()
    elo_df["elo"] = elo_df["rating"].apply(lambda r: r.get("elo") if isinstance(r, dict) else None)
    # merge_asof with `by=` still requires the `on` column sorted across the
    # WHOLE frame (not just within each by-group) - sort by week alone.
    elo_df = elo_df.dropna(subset=["elo"]).sort_values("week")

    out = []
    for role, id_col in [("home", "home_id"), ("away", "away_id")]:
        g = games[["id", "season", "week", id_col]].rename(columns={id_col: "team_id", "id": "game_id"})
        g = g.sort_values("week")
        merged = pd.merge_asof(
            g,
            elo_df.rename(columns={"week": "elo_week"}),
            left_on="week",
            right_on="elo_week",
            by=["season", "team_id"],
            direction="backward",
            allow_exact_matches=False,  # strictly BEFORE the game's own week
        )
        merged["role"] = role
        out.append(merged[["game_id", "team_id", "elo", "role"]])
    return pd.concat(out, ignore_index=True)


def build_training_dataset(seasons: list[int]) -> pd.DataFrame:
    if not seasons:
        raise ValueError("seasons must be non-empty")
    all_seasons = sorted(set(seasons))
    prior_seasons = sorted({s - 1 for s in all_seasons})
    # market_rating needs the FULL chronological history to bootstrap its
    # season-to-season prior chain correctly, not just the requested range.
    history_start = min(all_seasons) - 1
    history_seasons = list(range(history_start, max(all_seasons) + 1))

    print(f"Loading games for {history_seasons}...")
    all_games = _load_games(history_seasons)
    games = all_games[all_games["season"].isin(all_seasons)].copy()
    if games.empty:
        return pd.DataFrame()

    print("Loading market lines...")
    all_lines = _load_market_lines(all_games["id"].tolist())
    lines = all_lines.set_index("game_id")

    print("Loading team game stats...")
    game_stats = _load_team_game_stats(all_games["id"].tolist())
    cum_stats = _cumulative_pregame_stats(all_games, game_stats) if not game_stats.empty else pd.DataFrame()
    cum_scoring = _cumulative_scoring(all_games)

    print("Loading box score stats...")
    boxscore = _load_boxscore(all_games["id"].tolist())
    cum_box = _cumulative_boxscore(all_games, boxscore) if not boxscore.empty else pd.DataFrame()

    print("Loading Elo...")
    # source filter applied post-fetch since fetch_all only supports eq-per-kwarg.
    elo_raw = _fetch_seasons("team_ratings", "season,week,team_id,rating,source", history_seasons)
    elo_asof = pd.DataFrame()
    if not elo_raw.empty:
        elo_only = elo_raw[elo_raw["source"] == "elo"]
        elo_asof = _asof_elo(elo_only, all_games)

    print("Loading prior-season SP+...")
    prior_ratings = _fetch_seasons("team_ratings", "season,week,team_id,team,rating,source", prior_seasons)

    sp_prior = prior_ratings[(prior_ratings["source"] == "sp_plus") & (prior_ratings["week"] == 0)] if not prior_ratings.empty else prior_ratings
    if not sp_prior.empty:
        sp_prior = sp_prior.copy()
        sp_prior["sp_plus"] = sp_prior["rating"].apply(lambda r: r.get("rating") if isinstance(r, dict) else None)
        sp_prior["season"] = sp_prior["season"] + 1  # index by the season it's a PRIOR for

    # SRS is the one rating source that covers FCS too (Elo/SP+/FPI are
    # FBS-only, verified live) - same season-final-only limitation as SP+
    # (doesn't vary by week regardless of the week param), so same
    # prior-season-only treatment to stay leakage-safe.
    srs_prior = prior_ratings[(prior_ratings["source"] == "srs") & (prior_ratings["week"] == 0)] if not prior_ratings.empty else prior_ratings
    if not srs_prior.empty:
        srs_prior = srs_prior.copy()
        srs_prior["srs"] = srs_prior["rating"].apply(lambda r: r.get("rating") if isinstance(r, dict) else None)
        srs_prior["season"] = srs_prior["season"] + 1

    print("Loading team talent / returning production...")
    talent = _fetch_seasons("team_talent", "season,team_id,talent", all_seasons)
    returning = _fetch_seasons("team_returning_production", "season,team_id,stats", all_seasons)
    if not returning.empty:
        returning = returning.copy()
        returning["returning_ppa_pct"] = returning["stats"].apply(lambda s: s.get("percentPPA") if isinstance(s, dict) else None)

    print("Loading transfer portal...")
    transfers = _fetch_seasons("player_transfers", "season,origin_team_id,destination_team_id,stars,eligibility", all_seasons)
    net_transfer_stars = pd.DataFrame(columns=["season", "team_id", "net_transfer_stars"])
    if not transfers.empty:
        immediate = transfers[transfers["eligibility"] == "Immediate"].copy()
        incoming = immediate.dropna(subset=["destination_team_id"]).groupby(["season", "destination_team_id"])["stars"].sum()
        outgoing = immediate.dropna(subset=["origin_team_id"]).groupby(["season", "origin_team_id"])["stars"].sum()
        incoming.index.names = outgoing.index.names = ["season", "team_id"]
        net = incoming.sub(outgoing, fill_value=0).reset_index(name="net_transfer_stars")
        net_transfer_stars = net

    print("Computing market-implied power ratings...")
    market_input = all_games.merge(lines[["spread"]], left_on="id", right_index=True, how="left")
    market_ratings = compute_expanding_market_ratings(
        market_input[["season", "week", "home_team", "away_team", "spread", "neutral_site"]]
    )

    print("Computing our own results-based power ratings...")
    results_input = all_games.copy()
    results_input["actual_margin"] = results_input["home_points"] - results_input["away_points"]
    results_ratings = compute_expanding_results_ratings(
        results_input[["season", "week", "home_team", "away_team", "actual_margin", "neutral_site"]]
    )

    print("Loading coaching continuity...")
    coaching = _fetch_seasons("team_coaching", "season,team_id,is_new_coach", all_seasons)

    print("Computing CFB Trader Desk power ratings (scoring + efficiency, own O/D system)...")
    id_to_name = pd.Series(all_games["home_team"].values, index=all_games["home_id"]).to_dict()
    id_to_name.update(pd.Series(all_games["away_team"].values, index=all_games["away_id"]).to_dict())
    continuity_multipliers = build_continuity_multipliers(all_seasons, returning, net_transfer_stars, coaching, id_to_name)

    # Names, not ids - power_rating.py's fit works in team-name space. Used
    # only to pick the centering reference (0 = average FBS team), not to
    # filter games; FBS/FCS still fit together in one linked system.
    fbs_teams = set(all_games.loc[all_games["home_classification"] == "fbs", "home_team"]) | set(
        all_games.loc[all_games["away_classification"] == "fbs", "away_team"]
    )

    scoring_ratings = compute_expanding_scoring_ratings(
        all_games[["season", "week", "home_team", "away_team", "home_points", "away_points", "neutral_site"]],
        continuity_multipliers,
        fbs_teams,
    )

    # Replace each season's week-1 (0-games-played) scoring rows with the
    # learned preseason projection model instead of the flat continuity-
    # shrink heuristic compute_expanding_scoring_ratings falls back to -
    # matches what's live in sync_power_ratings.py. Historically this
    # backtest was silently testing the OLDER heuristic, not the model
    # actually serving current ratings - this closes that gap. Trained
    # fresh per season boundary (walk-forward safe: only ever sees
    # strictly earlier seasons), so this is the same discipline as every
    # other model in this file, just looped per season since the
    # projection model itself needs its own walk-forward retraining.
    from .preseason_projection import (  # local import - avoids a circular import (preseason_projection imports from this module)
        build_projection_dataset as _build_proj_dataset,
        predict_projection as _predict_proj,
        train_projection_def_model as _train_proj_def,
        train_projection_off_model as _train_proj_off,
    )

    proj_source = _build_proj_dataset(all_seasons)
    first_week_by_season = scoring_ratings.groupby("season")["week"].min().to_dict()
    override_rows = []
    for season in all_seasons:
        proj_train = proj_source[proj_source["season"] < season]
        proj_current = proj_source[
            (proj_source["season"] == season) & proj_source["prior_off"].notna() & proj_source["prior_def"].notna()
        ]
        wk = first_week_by_season.get(season)
        if proj_train.empty or proj_current.empty or wk is None:
            continue
        off_model = _train_proj_off(proj_train)
        def_model = _train_proj_def(proj_train)
        pred = _predict_proj(off_model, def_model, proj_current)
        for _, r in pred.iterrows():
            override_rows.append(
                {"season": season, "week": wk, "team": r["team"], "scoring_off": r["predicted_off"], "scoring_def": r["predicted_def"]}
            )
    if override_rows:
        override_df = pd.DataFrame(override_rows).set_index(["season", "week", "team"])
        scoring_ratings = scoring_ratings.set_index(["season", "week", "team"])
        scoring_ratings.update(override_df)
        scoring_ratings = scoring_ratings.reset_index()

    ppa_by_game_team = game_stats[["game_id", "team_id", "off_ppa"]] if not game_stats.empty else pd.DataFrame(columns=["game_id", "team_id", "off_ppa"])
    ppa_input = all_games.merge(
        ppa_by_game_team.rename(columns={"team_id": "home_id", "off_ppa": "home_ppa"}), left_on=["id", "home_id"], right_on=["game_id", "home_id"], how="left"
    ).merge(ppa_by_game_team.rename(columns={"team_id": "away_id", "off_ppa": "away_ppa"}), left_on=["id", "away_id"], right_on=["game_id", "away_id"], how="left")
    efficiency_ratings = compute_expanding_efficiency_ratings(
        ppa_input[["season", "week", "home_team", "away_team", "home_ppa", "away_ppa", "neutral_site"]],
        continuity_multipliers,
        fbs_teams,
    )

    # --- Assemble ---
    def lookup(df: pd.DataFrame, season_col: str, team_col: str, value_col: str) -> dict:
        if df.empty:
            return {}
        return {(row[season_col], row[team_col]): row[value_col] for _, row in df.iterrows()}

    cum_lookup = {(r["game_id"], r["team_id"]): r for _, r in cum_stats.iterrows()} if not cum_stats.empty else {}
    scoring_lookup = {(r["game_id"], r["team_id"]): r for _, r in cum_scoring.iterrows()}
    box_lookup = {(r["game_id"], r["team_id"]): r for _, r in cum_box.iterrows()} if not cum_box.empty else {}
    elo_lookup = {(r["game_id"], r["team_id"], r["role"]): r["elo"] for _, r in elo_asof.iterrows()} if not elo_asof.empty else {}
    sp_lookup = lookup(sp_prior, "season", "team_id", "sp_plus") if not sp_prior.empty else {}
    srs_lookup = lookup(srs_prior, "season", "team_id", "srs") if not srs_prior.empty else {}
    talent_lookup = lookup(talent, "season", "team_id", "talent") if not talent.empty else {}
    returning_lookup = lookup(returning, "season", "team_id", "returning_ppa_pct") if not returning.empty else {}
    transfer_lookup = lookup(net_transfer_stars, "season", "team_id", "net_transfer_stars") if not net_transfer_stars.empty else {}
    market_lookup = {(r["season"], r["week"], r["team"]): r["market_rating"] for _, r in market_ratings.iterrows()} if not market_ratings.empty else {}
    results_lookup = {(r["season"], r["week"], r["team"]): r["results_rating"] for _, r in results_ratings.iterrows()} if not results_ratings.empty else {}
    power_scoring_lookup = {(r["season"], r["week"], r["team"]): r for _, r in scoring_ratings.iterrows()} if not scoring_ratings.empty else {}
    power_efficiency_lookup = {(r["season"], r["week"], r["team"]): r for _, r in efficiency_ratings.iterrows()} if not efficiency_ratings.empty else {}

    rows = []
    for g in games.itertuples():
        line = lines.loc[g.id] if g.id in lines.index else None

        def cum(team_id: int, col: str):
            r = cum_lookup.get((g.id, team_id))
            return r[col] if r is not None else None

        def scoring(team_id: int, col: str):
            r = scoring_lookup.get((g.id, team_id))
            return r[col] if r is not None else None

        def box(team_id: int, col: str):
            r = box_lookup.get((g.id, team_id))
            return r[col] if r is not None else None

        home_elo = elo_lookup.get((g.id, g.home_id, "home"))
        away_elo = elo_lookup.get((g.id, g.away_id, "away"))

        row = {
            "game_id": g.id,
            "season": g.season,
            "week": g.week,
            "neutral_site": g.neutral_site,
            "conference_game": g.conference_game,
            "home_power_conf": g.home_power_conf,
            "away_power_conf": g.away_power_conf,
            "home_classification": g.home_classification,  # kept for filtering/segmentation, not a numeric model feature
            "away_classification": g.away_classification,
            "home_is_fbs": g.home_classification == "fbs",  # numeric equivalents, usable directly as features
            "away_is_fbs": g.away_classification == "fbs",
            "is_cross_division": g.is_cross_division,
            "day_of_week": g.start_date.dayofweek,  # 0=Mon..6=Sun -- public betting behavior differs Sat vs weeknight games
            "elo_diff": (home_elo - away_elo) if home_elo is not None and away_elo is not None else None,
            "home_prior_srs": srs_lookup.get((g.season, g.home_id)),
            "away_prior_srs": srs_lookup.get((g.season, g.away_id)),
            **{f"home_cum_{c}": cum(g.home_id, f"cum_{c}") for c in PPA_STAT_COLS},
            **{f"away_cum_{c}": cum(g.away_id, f"cum_{c}") for c in PPA_STAT_COLS},
            "home_cum_points_scored": scoring(g.home_id, "cum_points_scored"),
            "home_cum_points_allowed": scoring(g.home_id, "cum_points_allowed"),
            "away_cum_points_scored": scoring(g.away_id, "cum_points_scored"),
            "away_cum_points_allowed": scoring(g.away_id, "cum_points_allowed"),
            "home_games_played": scoring(g.home_id, "cum_games_played"),
            "away_games_played": scoring(g.away_id, "cum_games_played"),
            "home_cum_turnover_margin": box(g.home_id, "cum_turnover_margin"),
            "away_cum_turnover_margin": box(g.away_id, "cum_turnover_margin"),
            "home_cum_possession_seconds": box(g.home_id, "cum_possession_seconds"),
            "away_cum_possession_seconds": box(g.away_id, "cum_possession_seconds"),
            "home_cum_third_down_pct": box(g.home_id, "cum_third_down_pct"),
            "away_cum_third_down_pct": box(g.away_id, "cum_third_down_pct"),
            "home_cum_penalty_yards": box(g.home_id, "cum_penalty_yards"),
            "away_cum_penalty_yards": box(g.away_id, "cum_penalty_yards"),
            "home_prior_sp_plus": sp_lookup.get((g.season, g.home_id)),
            "away_prior_sp_plus": sp_lookup.get((g.season, g.away_id)),
            "home_talent": talent_lookup.get((g.season, g.home_id)),
            "away_talent": talent_lookup.get((g.season, g.away_id)),
            "home_returning_ppa_pct": returning_lookup.get((g.season, g.home_id)),
            "away_returning_ppa_pct": returning_lookup.get((g.season, g.away_id)),
            "home_net_transfer_stars": transfer_lookup.get((g.season, g.home_id), 0),
            "away_net_transfer_stars": transfer_lookup.get((g.season, g.away_id), 0),
            "home_market_rating": market_lookup.get((g.season, g.week, g.home_team)),
            "away_market_rating": market_lookup.get((g.season, g.week, g.away_team)),
            "home_results_rating": results_lookup.get((g.season, g.week, g.home_team)),
            "away_results_rating": results_lookup.get((g.season, g.week, g.away_team)),
            "home_scoring_off": power_scoring_lookup.get((g.season, g.week, g.home_team), {}).get("scoring_off"),
            "home_scoring_def": power_scoring_lookup.get((g.season, g.week, g.home_team), {}).get("scoring_def"),
            "away_scoring_off": power_scoring_lookup.get((g.season, g.week, g.away_team), {}).get("scoring_off"),
            "away_scoring_def": power_scoring_lookup.get((g.season, g.week, g.away_team), {}).get("scoring_def"),
            "home_efficiency_off": power_efficiency_lookup.get((g.season, g.week, g.home_team), {}).get("efficiency_off"),
            "home_efficiency_def": power_efficiency_lookup.get((g.season, g.week, g.home_team), {}).get("efficiency_def"),
            "away_efficiency_off": power_efficiency_lookup.get((g.season, g.week, g.away_team), {}).get("efficiency_off"),
            "away_efficiency_def": power_efficiency_lookup.get((g.season, g.week, g.away_team), {}).get("efficiency_def"),
            # Targets
            "actual_margin": g.home_points - g.away_points,
            "actual_total": g.home_points + g.away_points,
            "home_win": g.home_points > g.away_points,
            "market_spread": line["spread"] if line is not None else None,
            "market_spread_open": line["spread_open"] if line is not None else None,
            "market_total": line["over_under"] if line is not None else None,
            "market_total_open": line["over_under_open"] if line is not None else None,
            "market_home_moneyline": line["home_moneyline"] if line is not None else None,
            "market_away_moneyline": line["away_moneyline"] if line is not None else None,
            # Not meaningful on neutral-site games (no real home-field edge to
            # be "the favorite despite" or "the dog despite") - keep
            # neutral_site alongside this in any analysis, don't drop it.
            "is_home_favorite": (line["spread_open"] < 0) if line is not None and pd.notna(line["spread_open"]) else None,
            "spread_move": (line["spread"] - line["spread_open"]) if line is not None and pd.notna(line["spread_open"]) and pd.notna(line["spread"]) else None,
            "total_move": (line["over_under"] - line["over_under_open"]) if line is not None and pd.notna(line["over_under_open"]) and pd.notna(line["over_under"]) else None,
        }
        rows.append(row)

    return pd.DataFrame(rows)
