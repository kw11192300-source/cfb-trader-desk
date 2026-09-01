"""
Backfills raw per-game box score stats (turnovers, possession time, 3rd/4th
down efficiency, penalties, yards) from CFBD's /games/teams endpoint —
distinct from the PPA-derived advanced stats in team_game_stats. Turnover
margin and time of possession specifically were missing from the feature
set entirely; both are classically predictive (turnovers for outcomes,
possession time for pace/totals) in ways PPA/success-rate don't capture.

CFBD returns most categories as plain numbers but a few as raw strings
that need parsing: possessionTime ("26:14" -> seconds), thirdDownEff/
fourthDownEff ("4-12" -> made/attempted), totalPenaltiesYards ("3-31" ->
count/yards).

Usage:
    python -m cfbd_ingest.backfill_boxscore --start 2015 --end 2026
"""
from __future__ import annotations

import argparse
import datetime

from . import cfbd_client as cfbd
from .config import require_env
from .supabase_client import fetch_all, get_client

CHUNK_SIZE = 500
MAX_WEEK = 17


def chunked(items: list, size: int = CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _parse_mmss(value: str | None) -> int | None:
    """'26:14' -> 1574 (seconds). None/malformed -> None."""
    if not value or ":" not in value:
        return None
    try:
        m, s = value.split(":")
        return int(m) * 60 + int(s)
    except ValueError:
        return None


def _parse_fraction(value: str | None) -> tuple[int | None, int | None]:
    """'4-12' -> (4, 12) as (made, attempted). None/malformed -> (None, None)."""
    if not value or "-" not in value:
        return None, None
    try:
        made, attempted = value.split("-")
        return int(made), int(attempted)
    except ValueError:
        return None, None


def _parse_team_stats(raw_stats: list[dict]) -> dict:
    by_cat = {s["category"]: s["stat"] for s in raw_stats}

    def num(key: str) -> float | None:
        v = by_cat.get(key)
        if v is None:
            return None
        try:
            return float(v)
        except ValueError:
            return None

    third_made, third_att = _parse_fraction(by_cat.get("thirdDownEff"))
    fourth_made, fourth_att = _parse_fraction(by_cat.get("fourthDownEff"))
    pen_count, pen_yards = _parse_fraction(by_cat.get("totalPenaltiesYards"))

    return {
        "turnovers": num("turnovers"),
        "fumbles_lost": num("fumblesLost"),
        "interceptions_thrown": num("interceptions"),
        "possession_seconds": _parse_mmss(by_cat.get("possessionTime")),
        "third_down_made": third_made,
        "third_down_attempted": third_att,
        "fourth_down_made": fourth_made,
        "fourth_down_attempted": fourth_att,
        "penalties": pen_count,
        "penalty_yards": pen_yards,
        "total_yards": num("totalYards"),
        "rushing_yards": num("rushingYards"),
        "net_passing_yards": num("netPassingYards"),
        "first_downs": num("firstDowns"),
    }


def run(start_year: int, end_year: int) -> None:
    require_env()
    client = get_client()
    teams = fetch_all("teams", "id,school")
    name_to_id = {t["school"]: t["id"] for t in teams}
    known_game_ids = {g["id"] for g in fetch_all("games", "id")}

    for year in range(start_year, end_year + 1):
        print(f"=== {year} ===")
        records = []
        for week in range(1, MAX_WEEK + 1):
            rows = cfbd._get("/games/teams", {"year": year, "week": week})
            for game in rows:
                if game["id"] not in known_game_ids:
                    continue  # not one of our (FBS-filtered) games - avoid the FK violation pattern seen elsewhere
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
        if not records:
            print(f"  no data returned for {year}")
            continue
        deduped = {(r["game_id"], r["team_id"]): r for r in records}
        records = list(deduped.values())
        for batch in chunked(records):
            client.table("team_game_boxscore").upsert(batch, on_conflict="game_id,team_id").execute()
        print(f"  upserted {len(records)} box score rows")

    print("Box score backfill complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill raw per-game box score stats.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.start, args.end)
