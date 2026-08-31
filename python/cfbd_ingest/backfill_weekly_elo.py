"""
One-time (re-runnable) backfill of WEEKLY Elo ratings for every historical
season. The original historical backfill (backfill.py) only pulled
season-final Elo (week=0) — this fills in real point-in-time week-by-week
values, verified live to actually vary within a season (unlike SP+/FPI/SRS,
which CFBD only serves as season-final regardless of the week param — see
python/modeling/README.md once written, or the plan this was built from).

Modeling needs this for leakage-safe features: "Elo as of the week before
game X" instead of accidentally using the season's final Elo (which bakes
in results from games not yet played at the time being modeled).

Usage:
    python -m cfbd_ingest.backfill_weekly_elo --start 2015 --end 2026
"""
from __future__ import annotations

import argparse
import datetime

from . import cfbd_client as cfbd
from .config import require_env
from .supabase_client import fetch_all, get_client

CHUNK_SIZE = 500
MAX_WEEK = 17  # covers regular season + conference championship week; harmless if a season is shorter


def chunked(items: list, size: int = CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def run(start_year: int, end_year: int) -> None:
    require_env()
    client = get_client()

    teams = fetch_all("teams", "id,school")
    name_to_id = {t["school"]: t["id"] for t in teams}

    for year in range(start_year, end_year + 1):
        print(f"=== {year} ===")
        records = []
        for week in range(1, MAX_WEEK + 1):
            rows = cfbd.fetch_elo_ratings(year, week=week)
            if not rows:
                continue
            for row in rows:
                team_id = name_to_id.get(row.get("team"))
                if team_id is None or row.get("elo") is None:
                    continue
                records.append(
                    {
                        "season": year,
                        "week": week,
                        "team_id": team_id,
                        "team": row["team"],
                        "source": "elo",
                        "rating": {"elo": row["elo"]},
                    }
                )
        if not records:
            print(f"  no data returned for {year}")
            continue
        # Same defensive dedupe as backfill.py's upsert() — CFBD has been seen
        # to emit exact-duplicate rows for a key on other rating endpoints.
        key_cols = ("season", "team_id", "source", "week")
        deduped = {tuple(r[k] for k in key_cols): r for r in records}
        records = list(deduped.values())
        for batch in chunked(records):
            client.table("team_ratings").upsert(batch, on_conflict="season,team_id,source,week").execute()
        print(f"  upserted {len(records)} weekly elo rows")

    print("Weekly Elo backfill complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill weekly (point-in-time) Elo ratings.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.start, args.end)
