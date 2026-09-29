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
    Scoped explicitly by sport - a stray row from another sport (negative
    id, same shared games table) shouldn't ever be able to influence this.

    `season` is stored by start-year (e.g. the 2026-27 NHL/NFL season is
    `season=2026`), but a season that crosses the calendar boundary still
    has real games in the new year - so this checks both the current and
    prior calendar year, not just today's, or every NHL/NFL game from
    January onward would be invisible to this query (CFB doesn't cross the
    boundary, so this is a no-op widening for it)."""
    client = get_client()
    year = datetime.date.today().year
    res = (
        client.table("games")
        .select("season,week,season_type,start_date")
        .eq("sport", sport)
        .in_("season", [year, year - 1])
        .eq("completed", False)
        .order("start_date")
        .limit(1)
        .execute()
    )
    if not res.data:
        return None
    row = res.data[0]
    return row["season"], row["week"], row["season_type"]
