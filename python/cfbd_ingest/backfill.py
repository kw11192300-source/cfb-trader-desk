"""
One-time (or re-runnable) historical backfill: pulls games, betting lines,
team stats, and ratings from CFBD for a range of seasons and upserts them
into Supabase.

Usage:
    python -m cfbd_ingest.backfill                 # 2015..current season
    python -m cfbd_ingest.backfill --start 2018     # 2018..current season
    python -m cfbd_ingest.backfill --start 2018 --end 2020

Safe to re-run: everything is upserted on primary key, so pulling the same
season twice just overwrites with fresher data (useful for the in-season
weekly sync too — see sync_week.py).
"""
from __future__ import annotations

import argparse
import datetime
from typing import Any

from . import cfbd_client as cfbd
from .config import require_env
from .supabase_client import get_client

CHUNK_SIZE = 500


def chunked(items: list[Any], size: int = CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def upsert(table: str, records: list[dict], on_conflict: str) -> None:
    if not records:
        return
    # CFBD occasionally emits exact-duplicate rows for the same key (seen on
    # /ratings/srs — same team/rating twice, once missing `conference`). A
    # single upsert command can't touch the same conflict key twice, so
    # dedupe here, keeping the last occurrence, rather than at every call site.
    key_cols = on_conflict.split(",")
    deduped = {tuple(r.get(k) for k in key_cols): r for r in records}
    records = list(deduped.values())

    client = get_client()
    for batch in chunked(records):
        client.table(table).upsert(batch, on_conflict=on_conflict).execute()
    print(f"  upserted {len(records)} rows into {table}")


def backfill_teams() -> dict[str, int]:
    print("Fetching teams...")
    teams = cfbd.fetch_teams(classification="fbs")
    records = []
    name_to_id: dict[str, int] = {}
    for t in teams:
        team_id = t["id"]
        school = t["school"]
        name_to_id[school] = team_id
        records.append(
            {
                "id": team_id,
                "school": school,
                "mascot": t.get("mascot"),
                "conference": t.get("conference"),
                "classification": t.get("classification"),
                "color": t.get("color"),
                "alt_color": t.get("alternateColor") or t.get("altColor"),
                "logo_url": f"https://cdn.collegefootballdata.com/logos/64/{team_id}.png",
            }
        )
    upsert("teams", records, on_conflict="id")
    return name_to_id


def backfill_games(year: int) -> set[int]:
    print(f"[{year}] Fetching games...")
    games = cfbd.fetch_games(year, season_type="regular") + cfbd.fetch_games(year, season_type="postseason")
    records = []
    for g in games:
        if g.get("homeId") is None or g.get("awayId") is None:
            continue  # skip games missing a team id (e.g. FCS-only matchups we don't track)
        records.append(
            {
                "id": g["id"],
                "season": g["season"],
                "week": g["week"],
                "season_type": g.get("seasonType", "regular"),
                "start_date": g["startDate"],
                "completed": bool(g.get("completed")),
                "neutral_site": bool(g.get("neutralSite")),
                "venue": g.get("venue"),
                "home_id": g.get("homeId"),
                "home_team": g["homeTeam"],
                "home_conference": g.get("homeConference"),
                "home_points": g.get("homePoints"),
                "away_id": g.get("awayId"),
                "away_team": g["awayTeam"],
                "away_conference": g.get("awayConference"),
                "away_points": g.get("awayPoints"),
            }
        )
    upsert("games", records, on_conflict="id")
    return {r["id"] for r in records}


def backfill_lines(year: int, known_game_ids: set[int]) -> None:
    """known_game_ids restricts to games we actually ingested (backfill_games,
    which filters to FBS). /lines has no reliable classification filter of its
    own, and would otherwise include FCS-vs-FCS games that violate the
    betting_lines -> games foreign key."""
    print(f"[{year}] Fetching betting lines...")
    games = cfbd.fetch_lines(year, season_type="regular") + cfbd.fetch_lines(year, season_type="postseason")
    records = []
    for g in games:
        if g["id"] not in known_game_ids:
            continue
        for line in g.get("lines", []):
            if line.get("spread") is None and line.get("overUnder") is None:
                continue
            records.append(
                {
                    "game_id": g["id"],
                    "provider": line["provider"],
                    "spread": line.get("spread"),
                    "spread_open": line.get("spreadOpen"),
                    "over_under": line.get("overUnder"),
                    "over_under_open": line.get("overUnderOpen"),
                    "home_moneyline": line.get("homeMoneyline"),
                    "away_moneyline": line.get("awayMoneyline"),
                    "formatted_spread": line.get("formattedSpread"),
                }
            )
    upsert("betting_lines", records, on_conflict="game_id,provider")


def backfill_team_stats(year: int, name_to_id: dict[str, int]) -> None:
    print(f"[{year}] Fetching team season stats (regular + advanced)...")
    regular = cfbd.fetch_team_season_stats(year)
    advanced = cfbd.fetch_team_season_advanced_stats(year)

    by_team: dict[str, dict[str, Any]] = {}

    # Regular /stats/season comes back flat: one row per (team, statName).
    for row in regular:
        team = row.get("team")
        if not team:
            continue
        bucket = by_team.setdefault(team, {"regular": {}, "advanced": {}})
        stat_name = row.get("statName")
        if stat_name:
            bucket["regular"][stat_name] = row.get("statValue")

    # /stats/season/advanced comes back nested per team already.
    for row in advanced:
        team = row.get("team")
        if not team:
            continue
        bucket = by_team.setdefault(team, {"regular": {}, "advanced": {}})
        bucket["advanced"] = {k: v for k, v in row.items() if k not in ("season", "team", "conference")}

    records = []
    for team, stats in by_team.items():
        team_id = name_to_id.get(team)
        if team_id is None:
            continue  # non-FBS opponent or name mismatch; skip rather than guess
        records.append({"season": year, "team_id": team_id, "team": team, "stats": stats})
    upsert("team_season_stats", records, on_conflict="season,team_id")


def backfill_team_game_stats(year: int, name_to_id: dict[str, int], known_game_ids: set[int]) -> None:
    """known_game_ids restricts to games we actually ingested — see backfill_lines
    for why (/stats/game/advanced isn't reliably classification-filtered either)."""
    print(f"[{year}] Fetching team game advanced stats...")
    rows = cfbd.fetch_team_game_advanced_stats(year, season_type="regular") + cfbd.fetch_team_game_advanced_stats(
        year, season_type="postseason"
    )
    records = []
    for row in rows:
        team = row.get("team")
        team_id = name_to_id.get(team)
        game_id = row.get("gameId")
        if team_id is None or game_id is None or game_id not in known_game_ids:
            continue
        stats = {k: v for k, v in row.items() if k not in ("gameId", "team", "opponent", "season", "week")}
        records.append({"game_id": game_id, "team_id": team_id, "team": team, "stats": stats})
    upsert("team_game_stats", records, on_conflict="game_id,team_id")


def backfill_ratings(year: int, name_to_id: dict[str, int]) -> None:
    print(f"[{year}] Fetching ratings (SP+, Elo, FPI, SRS)...")
    sources = {
        "sp_plus": cfbd.fetch_sp_ratings(year),
        "elo": cfbd.fetch_elo_ratings(year),
        "fpi": cfbd.fetch_fpi_ratings(year),
        "srs": cfbd.fetch_srs_ratings(year),
    }
    records = []
    for source, rows in sources.items():
        for row in rows:
            team = row.get("team")
            team_id = name_to_id.get(team)
            if team_id is None:
                continue
            rating = {k: v for k, v in row.items() if k not in ("season", "year", "team", "conference", "week")}
            records.append(
                {
                    "season": year,
                    "week": row.get("week") or 0,  # 0 = season-level/final (sp+, fpi, srs, and elo's final)
                    "team_id": team_id,
                    "team": team,
                    "source": source,
                    "rating": rating,
                }
            )
    upsert("team_ratings", records, on_conflict="season,team_id,source,week")


def run(start_year: int, end_year: int) -> None:
    require_env()
    name_to_id = backfill_teams()
    for year in range(start_year, end_year + 1):
        print(f"\n=== Season {year} ===")
        game_ids = backfill_games(year)
        backfill_lines(year, game_ids)
        backfill_team_stats(year, name_to_id)
        backfill_team_game_stats(year, name_to_id, game_ids)
        backfill_ratings(year, name_to_id)
    print("\nBackfill complete.")


if __name__ == "__main__":
    current_year = datetime.date.today().year
    parser = argparse.ArgumentParser(description="Backfill historical CFB data into Supabase.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=current_year)
    args = parser.parse_args()
    run(args.start, args.end)
