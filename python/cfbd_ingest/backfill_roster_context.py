"""
Backfills the three roster-turnover-context signals: team talent composite,
returning production %, and raw transfer portal entries. All three are
published before a season starts, so they're safe, leakage-free features
for early-season predictions — see team_talent/team_returning_production/
player_transfers in schema.sql for why these matter (a plain "last season's
rating" prior gets unreliable fast when half the roster turned over via the
portal, increasingly the norm in the NIL era).

One CFBD call per table per season — cheap. Re-runnable; everything upserts.

Usage:
    python -m cfbd_ingest.backfill_roster_context --start 2015 --end 2026
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


def upsert(client, table: str, records: list[dict], on_conflict: str | None) -> None:
    if not records:
        return
    for batch in chunked(records):
        q = client.table(table).upsert(batch, on_conflict=on_conflict) if on_conflict else client.table(table).upsert(batch)
        q.execute()
    print(f"  upserted {len(records)} rows into {table}")


def backfill_talent(client, year: int, name_to_id: dict[str, int]) -> None:
    rows = cfbd._get("/talent", {"year": year})
    records = []
    for r in rows:
        team_id = name_to_id.get(r.get("team"))
        if team_id is None or r.get("talent") is None:
            continue
        records.append({"season": year, "team_id": team_id, "team": r["team"], "talent": r["talent"]})
    upsert(client, "team_talent", records, "season,team_id")


def backfill_returning_production(client, year: int, name_to_id: dict[str, int]) -> None:
    rows = cfbd._get("/player/returning", {"year": year})
    records = []
    for r in rows:
        team_id = name_to_id.get(r.get("team"))
        if team_id is None:
            continue
        stats = {k: v for k, v in r.items() if k not in ("season", "team", "conference")}
        records.append({"season": year, "team_id": team_id, "team": r["team"], "stats": stats})
    upsert(client, "team_returning_production", records, "season,team_id")


def backfill_transfers(client, year: int, name_to_id: dict[str, int]) -> None:
    rows = cfbd._get("/player/portal", {"year": year})
    records = []
    for r in rows:
        origin = r.get("origin")
        destination = r.get("destination")
        records.append(
            {
                "season": year,
                "first_name": r.get("firstName"),
                "last_name": r.get("lastName"),
                "position": r.get("position"),
                "origin_team_id": name_to_id.get(origin),
                "origin_team": origin,
                "destination_team_id": name_to_id.get(destination) if destination else None,
                "destination_team": destination,
                "transfer_date": r.get("transferDate"),
                "rating": r.get("rating"),
                "stars": r.get("stars"),
                "eligibility": r.get("eligibility"),
            }
        )
    # No `id` to upsert on (bigserial) — the table's real dedupe key is the
    # unique constraint (season, first_name, last_name, origin_team,
    # transfer_date), so upsert on that instead of the primary key.
    upsert(client, "player_transfers", records, "season,first_name,last_name,origin_team,transfer_date")


def run(start_year: int, end_year: int) -> None:
    require_env()
    client = get_client()
    teams = fetch_all("teams", "id,school")
    name_to_id = {t["school"]: t["id"] for t in teams}

    for year in range(start_year, end_year + 1):
        print(f"=== {year} ===")
        backfill_talent(client, year, name_to_id)
        backfill_returning_production(client, year, name_to_id)
        backfill_transfers(client, year, name_to_id)

    print("Roster-context backfill complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill team talent, returning production, and transfer portal data.")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.start, args.end)
