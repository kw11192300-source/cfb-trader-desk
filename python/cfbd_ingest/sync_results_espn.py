"""
ESPN-based score sync - two jobs in one poll:
  1. Live tracking: while a game is in progress, writes its current score/
     period/clock to games.live_status (ESPN's public, keyless scoreboard
     API - the same one powering their own live scoreboard, so this is
     genuinely live, not just "eventually accurate").
  2. Final-score fallback: once ESPN shows a game final, updates
     completed/home_points/away_points directly - independent of CFBD's
     quota, so bet grading and the rest of the site never have to wait on
     CFBD's own (budget-constrained) sync-results.yml for a final score.

Deliberately does NOT touch team_stats/team_game_stats/ratings - ESPN's
scoreboard doesn't carry CFBD's richer per-play stats (PPA, success rate,
etc.), so sync_results.py (CFBD) still owns those, whenever its quota
allows. This script's job is scores/completion only, kept current far
more often than CFBD's 3x/day budget would allow.

Team names come back as ESPN's full "School Mascot" style, matched to our
own school names with the same fuzzy matcher already used for Odds API
and (in modeling/season_sim.py) ESPN schedule data - same shape of
matching problem each time.

Usage:
    python -m cfbd_ingest.sync_results_espn
"""
from __future__ import annotations

import datetime

import requests

from .current_week import get_current_week
from .supabase_client import get_client
from .team_match import find_best_school_match

ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"


def _espn_week_number(our_week: int) -> int:
    # Our own `week` numbering already matches CFBD's, which ESPN's
    # `week` param also follows for the regular season - no translation
    # needed today, but named as its own function in case that ever stops
    # being true (e.g. postseason numbering diverges).
    return our_week


def run() -> None:
    # Deliberately NOT calling config.require_env() - this script only
    # needs Supabase (get_client() below), never CFBD, so it shouldn't
    # demand CFBD_API_KEY as a prerequisite. That's the whole point of
    # having it as a CFBD-quota-independent fallback.
    current = get_current_week()
    if current is None:
        print("No current week found in our own games table - nothing to sync.")
        return
    season, week, season_type = current
    if season_type != "regular":
        print(f"Current week is '{season_type}', not 'regular' - ESPN sync only covers the regular season for now, skipping.")
        return

    client = get_client()
    ours = (
        client.table("games")
        .select("id,home_team,away_team,completed")
        .eq("season", season)
        .eq("week", week)
        .eq("season_type", "regular")
        .execute()
        .data
    )
    if not ours:
        print(f"No games in our own table for {season} week {week}.")
        return
    our_schools = list({g["home_team"] for g in ours} | {g["away_team"] for g in ours})

    resp = requests.get(
        ESPN_SCOREBOARD_URL,
        params={"year": season, "week": _espn_week_number(week), "seasontype": 2, "groups": 80, "limit": 300},
        timeout=30,
    )
    resp.raise_for_status()
    events = resp.json().get("events", [])
    print(f"{len(events)} ESPN events for {season} week {week}; matching against {len(ours)} of our own games.")

    finals = live = matched = unmatched = 0
    for e in events:
        comp = e["competitions"][0]
        competitors = comp["competitors"]
        home = next((c for c in competitors if c["homeAway"] == "home"), None)
        away = next((c for c in competitors if c["homeAway"] == "away"), None)
        if home is None or away is None:
            continue
        home_school = find_best_school_match(home["team"]["displayName"], our_schools)
        away_school = find_best_school_match(away["team"]["displayName"], our_schools)
        if home_school is None or away_school is None:
            unmatched += 1
            continue
        game = next((g for g in ours if g["home_team"] == home_school and g["away_team"] == away_school), None)
        if game is None:
            unmatched += 1
            continue
        matched += 1

        state = e.get("status", {}).get("type", {}).get("state")
        espn_completed = bool(e.get("status", {}).get("type", {}).get("completed"))

        if espn_completed:
            client.table("games").update(
                {
                    "completed": True,
                    "home_points": int(home["score"]),
                    "away_points": int(away["score"]),
                    "live_status": None,
                }
            ).eq("id", game["id"]).execute()
            finals += 1
        elif state == "in":
            status = e.get("status", {})
            client.table("games").update(
                {
                    "live_status": {
                        "home_points": int(home["score"]),
                        "away_points": int(away["score"]),
                        "period": status.get("period"),
                        "clock": status.get("displayClock"),
                        "detail": status.get("type", {}).get("shortDetail"),
                        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    }
                }
            ).eq("id", game["id"]).execute()
            live += 1
        # state == "pre" - nothing to update yet, leave as-is

    print(f"Matched {matched}/{len(events)} ({unmatched} unmatched). {finals} final, {live} live.")


if __name__ == "__main__":
    run()
