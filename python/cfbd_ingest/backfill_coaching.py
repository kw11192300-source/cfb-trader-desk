"""
Backfills coaching continuity: is_new_coach = the team's PRIMARY coach this
season (the one who coached the most games - filters out one-game bowl
interims, a real and common pattern: an OC often takes over for exactly
one bowl game after the real HC leaves for a new job) differs from last
season's primary coach.

An earlier version used the coach's hireDate directly and badly overcounted
(34% of FBS flagged as "new coach" in a spot check, vs a real ~12-15%/year
turnover rate) - caught by checking a flagged case (Freddie Kitchens at
North Carolina) and finding `games: 1`, a bowl-game interim, not the actual
incoming 2025 coach.

Usage:
    python -m cfbd_ingest.backfill_coaching --start 2015 --end 2026
"""
from __future__ import annotations

import argparse
import datetime

from . import cfbd_client as cfbd
from .config import require_env
from .supabase_client import fetch_all, get_client

CHUNK_SIZE = 500


def chunked(items: list, size: int = CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _primary_coaches(year: int) -> dict[str, tuple[str, str | None]]:
    """{school: (coach_name, hire_date)} - the coach with the most games
    for that school in that season (see module docstring for why 'most
    games' rather than any coach entry)."""
    rows = cfbd._get("/coaches", {"year": year})
    best: dict[str, tuple[str, str | None, int]] = {}
    for r in rows:
        name = f"{r.get('firstName', '')} {r.get('lastName', '')}".strip()
        for s in r.get("seasons", []):
            if s.get("year") != year:
                continue
            school = s.get("school")
            games = s.get("games") or 0
            if school not in best or games > best[school][2]:
                best[school] = (name, r.get("hireDate"), games)
    return {school: (name, hire_date) for school, (name, hire_date, _) in best.items()}


def run(start_year: int, end_year: int) -> None:
    require_env()
    client = get_client()
    teams = fetch_all("teams", "id,school")
    name_to_id = {t["school"]: t["id"] for t in teams}

    # Need year-1 to know what changed - fetch one extra year back.
    prior_year_coaches = _primary_coaches(start_year - 1)

    for year in range(start_year, end_year + 1):
        print(f"=== {year} ===")
        this_year_coaches = _primary_coaches(year)
        records = []
        for school, (coach_name, hire_date) in this_year_coaches.items():
            team_id = name_to_id.get(school)
            if team_id is None:
                continue
            prior_name = prior_year_coaches.get(school, (None, None))[0]
            is_new = prior_name is not None and prior_name != coach_name
            records.append(
                {
                    "season": year,
                    "team_id": team_id,
                    "team": school,
                    "coach_name": coach_name,
                    "hire_date": hire_date,
                    "is_new_coach": is_new,
                }
            )
        if records:
            for batch in chunked(records):
                client.table("team_coaching").upsert(batch, on_conflict="season,team_id").execute()
            print(f"  upserted {len(records)} rows ({sum(r['is_new_coach'] for r in records)} new-coach seasons)")
        else:
            print("  no data returned")
        prior_year_coaches = this_year_coaches

    print("Coaching backfill complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill coaching continuity.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.start, args.end)
