"""
Figures out "the current week" from our own games table: the earliest
not-yet-completed game with a known kickoff time, within the current
calendar year. That's the week that's either in progress or coming up next —
exactly what both sync_results and poll_lines need to target.

Deliberately simple (no CFBD calendar fallback): the historical backfill
already seeds the current season's games before this is ever called in
practice, so there's always something in our own table to look at.
"""
from __future__ import annotations

import datetime

from .supabase_client import get_client


def get_current_week(sport: str = "cfb") -> tuple[int, int, str] | None:
    """Returns (season, week, season_type), or None if there's no upcoming
    game in our own database (e.g. off-season with nothing backfilled yet).
    Every caller today is CFB-only, but scoped explicitly rather than left
    implicit - a stray NFL row (negative id, same games table) shouldn't
    ever be able to influence this."""
    client = get_client()
    year = datetime.date.today().year
    res = (
        client.table("games")
        .select("season,week,season_type,start_date")
        .eq("sport", sport)
        .eq("season", year)
        .eq("completed", False)
        .order("start_date")
        .limit(1)
        .execute()
    )
    if not res.data:
        return None
    row = res.data[0]
    return row["season"], row["week"], row["season_type"]
