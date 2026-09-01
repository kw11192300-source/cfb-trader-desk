"""
Extends the existing (FBS-only) backfill to cover FCS teams and games too —
per user request: FCS/smaller-conference markets are reportedly "softer"
(less efficiently priced) than major FBS markets, worth modeling in their
own right rather than just as FBS buy-game opponents.

What FCS coverage actually looks like in CFBD (verified live before
building this):
  - /games, /lines with classification=fcs: real coverage, including
    FCS-vs-FCS games with real betting lines (~97/98 games/week had lines
    in a spot check).
  - /stats/game/advanced, /talent, /player/returning: cover FCS teams too.
  - /ratings/elo, /ratings/sp, /ratings/fpi: FBS-only, no FCS data at all -
    already excluded from this backfill; SRS is the one rating source that
    does cover FCS, and was already captured for FCS teams incidentally by
    the original (unfiltered) ratings backfill in backfill.py.

FBS-vs-FCS "buy games" already exist in our games table (the FBS side
qualified them for the original classification=fbs backfill) - this script
adds the FCS-vs-FCS games those pulls never touched, and backfills
FCS-side stats/lines for ALL FCS-involved games (buy games included, since
those never got the FCS opponent's own team_game_stats/boxscore before).

Usage:
    python -m cfbd_ingest.backfill_fcs --start 2015 --end 2026
"""
from __future__ import annotations

import argparse
import datetime

from . import cfbd_client as cfbd
from .backfill import upsert
from .config import require_env
from .supabase_client import fetch_all, get_client


def backfill_fcs_teams() -> dict[str, int]:
    print("Fetching FCS teams...")
    teams = cfbd.fetch_teams(classification="fcs")
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


def backfill_fcs_games(year: int) -> set[int]:
    print(f"[{year}] Fetching FCS games...")
    games = cfbd.fetch_games(year, season_type="regular", classification="fcs") + cfbd.fetch_games(
        year, season_type="postseason", classification="fcs"
    )
    records = []
    for g in games:
        if g.get("homeId") is None or g.get("awayId") is None:
            continue
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


def backfill_fcs_lines(year: int, known_game_ids: set[int]) -> None:
    print(f"[{year}] Fetching FCS betting lines...")
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


def backfill_fcs_team_game_stats(year: int, name_to_id: dict[str, int], known_game_ids: set[int]) -> None:
    print(f"[{year}] Fetching FCS team game advanced stats...")
    rows = cfbd.fetch_team_game_advanced_stats(year, season_type="regular") + cfbd.fetch_team_game_advanced_stats(
        year, season_type="postseason"
    )
    records = []
    for row in rows:
        team_id = name_to_id.get(row.get("team"))
        game_id = row.get("gameId")
        if team_id is None or game_id is None or game_id not in known_game_ids:
            continue
        stats = {k: v for k, v in row.items() if k not in ("gameId", "team", "opponent", "season", "week")}
        records.append({"game_id": game_id, "team_id": team_id, "team": row["team"], "stats": stats})
    upsert("team_game_stats", records, on_conflict="game_id,team_id")


def backfill_fcs_boxscore(year: int, name_to_id: dict[str, int], known_game_ids: set[int]) -> None:
    from .backfill_boxscore import MAX_WEEK, _parse_team_stats

    print(f"[{year}] Fetching FCS box scores...")
    client = get_client()
    records = []
    for week in range(1, MAX_WEEK + 1):
        rows = cfbd._get("/games/teams", {"year": year, "week": week})
        for game in rows:
            if game["id"] not in known_game_ids:
                continue
            for team_entry in game.get("teams", []):
                team_id = name_to_id.get(team_entry.get("team"))
                if team_id is None:
                    continue
                records.append(
                    {
                        "game_id": game["id"],
                        "team_id": team_id,
                        "team": team_entry["team"],
                        "stats": _parse_team_stats(team_entry.get("stats", [])),
                    }
                )
    deduped = {(r["game_id"], r["team_id"]): r for r in records}
    records = list(deduped.values())
    for i in range(0, len(records), 500):
        client.table("team_game_boxscore").upsert(records[i : i + 500], on_conflict="game_id,team_id").execute()
    print(f"  upserted {len(records)} FCS box score rows")


def run(start_year: int, end_year: int) -> None:
    require_env()
    fcs_name_to_id = backfill_fcs_teams()
    fbs_teams = fetch_all("teams", "id,school")
    name_to_id = {t["school"]: t["id"] for t in fbs_teams}
    name_to_id.update(fcs_name_to_id)

    for year in range(start_year, end_year + 1):
        print(f"\n=== FCS {year} ===")
        game_ids = backfill_fcs_games(year)
        # Also cover FBS-vs-FCS buy games already in our table, whose FCS
        # side never got its own stats/boxscore backfilled - not just the
        # newly-added FCS-vs-FCS games.
        all_this_season = {g["id"] for g in fetch_all("games", "id", season=year)}
        game_ids |= all_this_season
        backfill_fcs_lines(year, game_ids)
        backfill_fcs_team_game_stats(year, name_to_id, game_ids)
        backfill_fcs_boxscore(year, name_to_id, game_ids)

    print("\nFCS backfill complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill FCS teams, games, lines, and stats.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.start, args.end)
