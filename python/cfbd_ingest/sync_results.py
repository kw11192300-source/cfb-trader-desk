"""
Daily-ish sync: refreshes scores/completion, team stats, and ratings for the
current season. Reuses the same upsert functions as the historical backfill
(everything's keyed on CFBD's own ids, so re-pulling the season is just
"whatever changed gets overwritten, nothing duplicates").

Deliberately does NOT touch betting lines — poll_lines.py owns that, on its
own (much tighter) schedule. Re-fetching the whole season here costs ~11
CFBD calls per run; fine run a few times a day, wasteful run every few
minutes (use poll_lines.py for anything that needs to be that fresh).

Usage:
    python -m cfbd_ingest.sync_results             # current season, from our own "current week"
    python -m cfbd_ingest.sync_results --year 2025 # explicit season
"""
from __future__ import annotations

import argparse
import datetime

from .backfill import (
    backfill_games,
    backfill_ratings,
    backfill_team_game_stats,
    backfill_team_stats,
    backfill_teams,
)
from .config import require_env


def run(year: int) -> None:
    require_env()
    print(f"Syncing results/stats for {year}...")
    name_to_id = backfill_teams()
    game_ids = backfill_games(year)
    backfill_team_stats(year, name_to_id)
    backfill_team_game_stats(year, name_to_id, game_ids)
    backfill_ratings(year, name_to_id)
    print("Sync complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync current-season results/stats/ratings.")
    parser.add_argument("--year", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    run(args.year)
