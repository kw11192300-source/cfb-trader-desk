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

from .market_rating import compute_expanding_market_ratings

MODEL_PROJECTIONS = {"numberfire", "teamrankings"}
BOOK_PREFERENCE = ["DraftKings", "consensus"]


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
    df["conference_game"] = df["home_conference"] == df["away_conference"]
    return df


def _pick_market_line(lines: pd.DataFrame) -> pd.DataFrame:
    """One row per game_id: prefers DraftKings, then consensus, then
    whichever provider has a non-null spread_open (needed for the movement
    target) — mirrors the sibling apps' pickSpread/pickHeadlineLine
    preference order, adapted for training-data consistency."""
    if lines.empty:
        return lines
    lines = lines[~lines["provider"].str.lower().isin(MODEL_PROJECTIONS)]

    def choose(group: pd.DataFrame) -> pd.Series:
        for book in BOOK_PREFERENCE:
            match = group[group["provider"] == book]
            if not match.empty and match.iloc[0]["spread_open"] is not None:
                return match.iloc[0]
        with_open = group[group["spread_open"].notna()]
        return (with_open.iloc[0] if not with_open.empty else group.iloc[0])

    return lines.groupby("game_id", group_keys=False).apply(choose, include_groups=False).reset_index()


def _load_market_lines(game_ids: list[int]) -> pd.DataFrame:
    raw = _fetch_by_game_ids("betting_lines", "game_id,provider,spread,spread_open,over_under,over_under_open", game_ids)
    return _pick_market_line(raw)


def _load_team_game_stats(seasons: list[int]) -> pd.DataFrame:
    raw = _fetch_seasons("team_game_stats", "game_id,team_id,team,stats", seasons)
    if raw.empty:
        return raw
    rows = []
    for r in raw.itertuples():
        off, dfn = r.stats.get("offense", {}), r.stats.get("defense", {})
        rows.append(
            {
                "game_id": r.game_id,
                "team_id": r.team_id,
                "team": r.team,
                "off_ppa": off.get("ppa"),
                "off_success_rate": off.get("successRate"),
                "off_explosiveness": off.get("explosiveness"),
                "def_ppa": dfn.get("ppa"),
                "def_success_rate": dfn.get("successRate"),
                "def_explosiveness": dfn.get("explosiveness"),
            }
        )
    return pd.DataFrame(rows)


def _cumulative_pregame_stats(games: pd.DataFrame, game_stats: pd.DataFrame) -> pd.DataFrame:
    """For each (season, team, game), the mean of that team's own
    team_game_stats from STRICTLY EARLIER games in that season (shift(1)
    before the expanding mean — the game itself is never included)."""
    stat_cols = ["off_ppa", "off_success_rate", "off_explosiveness", "def_ppa", "def_success_rate", "def_explosiveness"]
    merged = game_stats.merge(games[["id", "season", "start_date"]], left_on="game_id", right_on="id")
    merged = merged.sort_values(["season", "team_id", "start_date"])
    grouped = merged.groupby(["season", "team_id"], group_keys=False)
    for col in stat_cols:
        merged[f"cum_{col}"] = grouped[col].apply(lambda s: s.shift(1).expanding().mean())
    return merged[["game_id", "team_id"] + [f"cum_{c}" for c in stat_cols]]


def _asof_elo(elo_df: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Elo as of the most recent rated week strictly before each game's own
    week, per (season, team)."""
    if elo_df.empty:
        return pd.DataFrame(columns=["game_id", "team_id", "elo"])
    elo_df = elo_df.copy()
    elo_df["elo"] = elo_df["rating"].apply(lambda r: r.get("elo") if isinstance(r, dict) else None)
    elo_df = elo_df.dropna(subset=["elo"]).sort_values(["season", "team_id", "week"])

    out = []
    for role, id_col in [("home", "home_id"), ("away", "away_id")]:
        g = games[["id", "season", "week", id_col]].rename(columns={id_col: "team_id", "id": "game_id"})
        g = g.sort_values(["season", "team_id", "week"])
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
    game_stats = _load_team_game_stats(history_seasons)
    cum_stats = _cumulative_pregame_stats(all_games, game_stats) if not game_stats.empty else pd.DataFrame()

    print("Loading Elo...")
    elo_raw = _fetch_seasons("team_ratings", "season,week,team_id,rating", history_seasons)
    elo_asof = _asof_elo(elo_raw[elo_raw.index.isin(elo_raw.index)], all_games) if not elo_raw.empty else pd.DataFrame()
    # NOTE: source filter applied post-fetch since fetch_all only supports eq-per-kwarg.
    if not elo_raw.empty:
        elo_only = _fetch_seasons("team_ratings", "season,week,team_id,rating,source", history_seasons)
        elo_only = elo_only[elo_only["source"] == "elo"]
        elo_asof = _asof_elo(elo_only, all_games)

    print("Loading prior-season SP+...")
    sp_prior = _fetch_seasons("team_ratings", "season,week,team_id,team,rating,source", prior_seasons)
    sp_prior = sp_prior[(sp_prior["source"] == "sp_plus") & (sp_prior["week"] == 0)] if not sp_prior.empty else sp_prior
    if not sp_prior.empty:
        sp_prior = sp_prior.copy()
        sp_prior["sp_plus"] = sp_prior["rating"].apply(lambda r: r.get("rating") if isinstance(r, dict) else None)
        sp_prior["prior_season"] = sp_prior["season"]
        sp_prior["season"] = sp_prior["prior_season"] + 1  # index by the season it's a PRIOR for

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
        market_input.rename(columns={"season": "season", "week": "week"})[["season", "week", "home_team", "away_team", "spread", "neutral_site"]]
    )

    # --- Assemble ---
    def lookup(df: pd.DataFrame, season_col: str, team_col: str, value_col: str) -> dict:
        if df.empty:
            return {}
        return {(row[season_col], row[team_col]): row[value_col] for _, row in df.iterrows()}

    cum_lookup = {(r["game_id"], r["team_id"]): r for _, r in cum_stats.iterrows()} if not cum_stats.empty else {}
    elo_lookup = {(r["game_id"], r["team_id"], r["role"]): r["elo"] for _, r in elo_asof.iterrows()} if not elo_asof.empty else {}
    sp_lookup = lookup(sp_prior, "season", "team_id", "sp_plus") if not sp_prior.empty else {}
    talent_lookup = lookup(talent, "season", "team_id", "talent") if not talent.empty else {}
    returning_lookup = lookup(returning, "season", "team_id", "returning_ppa_pct") if not returning.empty else {}
    transfer_lookup = lookup(net_transfer_stars, "season", "team_id", "net_transfer_stars") if not net_transfer_stars.empty else {}
    market_lookup = {(r["season"], r["week"], r["team"]): r["market_rating"] for _, r in market_ratings.iterrows()} if not market_ratings.empty else {}

    rows = []
    for g in games.itertuples():
        line = lines.loc[g.id] if g.id in lines.index else None

        def cum(team_id: int, col: str):
            r = cum_lookup.get((g.id, team_id))
            return r[col] if r is not None else None

        home_elo = elo_lookup.get((g.id, g.home_id, "home"))
        away_elo = elo_lookup.get((g.id, g.away_id, "away"))

        row = {
            "game_id": g.id,
            "season": g.season,
            "week": g.week,
            "neutral_site": g.neutral_site,
            "conference_game": g.conference_game,
            "elo_diff": (home_elo - away_elo) if home_elo is not None and away_elo is not None else None,
            "home_cum_off_ppa": cum(g.home_id, "cum_off_ppa"),
            "home_cum_def_ppa": cum(g.home_id, "cum_def_ppa"),
            "home_cum_off_success_rate": cum(g.home_id, "cum_off_success_rate"),
            "home_cum_def_success_rate": cum(g.home_id, "cum_def_success_rate"),
            "away_cum_off_ppa": cum(g.away_id, "cum_off_ppa"),
            "away_cum_def_ppa": cum(g.away_id, "cum_def_ppa"),
            "away_cum_off_success_rate": cum(g.away_id, "cum_off_success_rate"),
            "away_cum_def_success_rate": cum(g.away_id, "cum_def_success_rate"),
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
            # Targets
            "actual_margin": g.home_points - g.away_points,
            "actual_total": g.home_points + g.away_points,
            "home_win": g.home_points > g.away_points,
            "market_spread": line["spread"] if line is not None else None,
            "market_spread_open": line["spread_open"] if line is not None else None,
            "market_total": line["over_under"] if line is not None else None,
            "market_total_open": line["over_under_open"] if line is not None else None,
            "spread_move": (line["spread"] - line["spread_open"]) if line is not None and pd.notna(line["spread_open"]) and pd.notna(line["spread"]) else None,
            "total_move": (line["over_under"] - line["over_under_open"]) if line is not None and pd.notna(line["over_under_open"]) and pd.notna(line["over_under"]) else None,
        }
        rows.append(row)

    return pd.DataFrame(rows)
