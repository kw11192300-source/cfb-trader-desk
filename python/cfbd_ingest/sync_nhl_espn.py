"""
Builds and keeps live the NHL schedule from ESPN's public, keyless
scoreboard API - same role as sync_nfl_espn.py, just for NHL. Schedule +
score tracking only, no CFBD-equivalent stats/ratings/model pipeline - this
exists to support manually logging and tracking NHL bets against the same
`games`/`bets` tables CFB/NFL already use, with `games.sport = 'nhl'`.

Two real differences from sync_nfl_espn.py, both because the NHL endpoint
has no notion of "week":

1. ESPN's NHL scoreboard takes a single `dates=YYYYMMDD` param (a whole-
   season or date-range query 400s - confirmed live), not `week`. A full
   ~190-day regular season would be 190 calls every run; instead this
   fetches a rolling window (WINDOW_DAYS_BACK..WINDOW_DAYS_FORWARD) each
   time - recently-finished games stay gradable, upcoming ones are visible
   a few weeks out, and the window naturally slides forward as the season
   plays out. This is a real, deliberate tradeoff against ESPN's free,
   unauthenticated endpoint - don't widen it casually.
2. `games.week` is required everywhere (Board, WeekTabs, current-week
   detection) but NHL has no real "week 1/2/3" structure. Bucketed here
   into sequential, season-relative week numbers instead (week = whole
   weeks since the season's earliest known game, +1) - NOT raw ISO
   calendar week, which would wrap back to 1 every January and break every
   piece of code that assumes week numbers only increase within a season.
   The anchor (season's earliest game) is derived from whatever's already
   in our own table for this season, widened by this run's own batch -
   self-correcting once the true season-opening date has been synced at
   least once, no hardcoded schedule dates to keep updated year to year.

ID collision: ESPN's event-id space is shared and overlapping across
sports (confirmed for CFB/NFL in sync_nfl_espn.py's own docstring). NFL
already claims "negative of the raw ESPN id" - a second negation here
would collide with it. Offset by a large constant before negating so NHL's
range sits nowhere near NFL's or CFB's (see NHL_ID_OFFSET below); a FOURTH
ESPN-sourced sport needs its own distinct offset, same reasoning.

Usage:
    python -m cfbd_ingest.sync_nhl_espn
"""
from __future__ import annotations

import datetime

import requests

from .supabase_client import get_client

ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard"
REGULAR_SEASON_TYPE = 2  # ESPN's season.type: 1=preseason, 2=regular, 3=postseason

WINDOW_DAYS_BACK = 3
WINDOW_DAYS_FORWARD = 21

NHL_ID_OFFSET = 5_000_000_000  # keeps NHL's negated-id range well clear of NFL's (see module docstring)


def _nhl_game_id(espn_id: str) -> int:
    return -(int(espn_id) + NHL_ID_OFFSET)


def _season_year() -> int:
    """The season-start year (e.g. the 2026-27 season is stored as 2026,
    matching CFB/NFL's own start-year convention) - NOT ESPN's own
    season.year field, which labels a season by the year it ENDS (an
    October 2026 game reports season.year=2027 - confirmed live). NHL's
    off-season runs roughly July-September, so anything from September
    onward belongs to the season starting that fall."""
    today = datetime.date.today()
    return today.year if today.month >= 9 else today.year - 1


def _fetch_day(date: datetime.date) -> list[dict]:
    resp = requests.get(ESPN_SCOREBOARD_URL, params={"dates": date.strftime("%Y%m%d")}, timeout=30)
    resp.raise_for_status()
    return resp.json().get("events", [])


def run() -> None:
    client = get_client()
    season = _season_year()
    now = datetime.datetime.now(datetime.timezone.utc)
    now_iso = now.isoformat()

    today = now.date()
    dates = [today + datetime.timedelta(days=d) for d in range(-WINDOW_DAYS_BACK, WINDOW_DAYS_FORWARD + 1)]

    events: list[dict] = []
    for d in dates:
        events.extend(_fetch_day(d))

    regular = [e for e in events if e.get("season", {}).get("type") == REGULAR_SEASON_TYPE]
    if not regular:
        print(f"No NHL regular-season events found in the {dates[0]}..{dates[-1]} window.")
        return

    # Season-relative week anchor: earliest known start_date for this
    # season, across both what's already synced and this batch - see
    # module docstring on why this beats a hardcoded season-start date.
    existing = (
        client.table("games")
        .select("start_date")
        .eq("sport", "nhl")
        .eq("season", season)
        .order("start_date")
        .limit(1)
        .execute()
        .data
    )
    batch_min = min(datetime.datetime.fromisoformat(e["date"].replace("Z", "+00:00")) for e in regular)
    anchor = batch_min if not existing else min(batch_min, datetime.datetime.fromisoformat(existing[0]["start_date"].replace("Z", "+00:00")))
    anchor_date = anchor.date()

    upserts = []
    for e in regular:
        comp = e["competitions"][0]
        competitors = comp["competitors"]
        home = next((c for c in competitors if c["homeAway"] == "home"), None)
        away = next((c for c in competitors if c["homeAway"] == "away"), None)
        if home is None or away is None:
            continue

        status = e.get("status", {})
        state = status.get("type", {}).get("state")
        completed = bool(status.get("type", {}).get("completed"))
        home_score = int(home["score"]) if home.get("score") not in (None, "") else None
        away_score = int(away["score"]) if away.get("score") not in (None, "") else None

        live_status = None
        if state == "in" and home_score is not None and away_score is not None:
            live_status = {
                "home_points": home_score,
                "away_points": away_score,
                "period": status.get("period"),
                "clock": status.get("displayClock"),
                "detail": status.get("type", {}).get("shortDetail"),
                "updated_at": now_iso,
            }

        event_date = datetime.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
        week = ((event_date.date() - anchor_date).days // 7) + 1

        upserts.append(
            {
                "id": _nhl_game_id(e["id"]),
                "sport": "nhl",
                "season": season,
                "week": week,
                "season_type": "regular",
                "start_date": e["date"],
                "completed": completed,
                "neutral_site": bool(comp.get("neutralSite", False)),
                "venue": (comp.get("venue") or {}).get("fullName"),
                "home_team": home["team"]["displayName"],
                "home_points": home_score,
                "away_team": away["team"]["displayName"],
                "away_points": away_score,
                "live_status": live_status,
            }
        )

    if not upserts:
        print("No NHL events found in window.")
        return
    for i in range(0, len(upserts), 500):
        client.table("games").upsert(upserts[i : i + 500], on_conflict="id").execute()
    print(f"Upserted {len(upserts)} NHL game(s) across {dates[0]}..{dates[-1]} (season {season}).")


if __name__ == "__main__":
    run()
