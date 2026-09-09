"""
Builds and keeps live the NFL schedule from ESPN's public, keyless
scoreboard API - the SOLE source for NFL data in this project right now.
No CFBD-equivalent stats/ratings/model pipeline exists for NFL yet - this
is schedule + score tracking only, to support manually logging and
tracking NFL bets against the same `games`/`bets` tables CFB already
uses, just with `games.sport = 'nfl'`.

Unlike sync_results_espn.py (which UPDATES existing CFBD-backfilled rows
by fuzzy-matching team names), this CREATES rows directly from ESPN -
there's no separate NFL schedule backfill to match against.

ID collision, confirmed live: ESPN's NFL event ids (e.g. 401872656) and
CFBD's own CFB game ids both draw from the same global ESPN event-id
sequence, and their ranges genuinely overlap (checked directly - that
exact NFL id falls inside our current CFB id range, 400603827-401913104).
Using ESPN's raw id as our games.id would risk silently colliding with
an existing CFB game. Fixed by negating it - all NFL rows get a NEGATIVE
id, all CFBD-sourced rows are always positive, so collision is
structurally impossible without any schema change. If another
ESPN-sourced sport gets added later (NBA/NHL/etc.), it needs its OWN
reserved id transform distinct from this one - negation alone isn't
enough once there are 3+ ESPN-sourced sports sharing the same source
id-space.

Usage:
    python -m cfbd_ingest.sync_nfl_espn
"""
from __future__ import annotations

import datetime

import requests

from .supabase_client import get_client

ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
REGULAR_SEASON_WEEKS = range(1, 19)  # NFL regular season is 18 weeks


def _nfl_game_id(espn_id: str) -> int:
    return -int(espn_id)


def _season_year() -> int:
    """The season that started this past Aug/Sep - NFL's season crosses
    the calendar year boundary (Sept-Feb), so from January through the
    summer "this season" still means last fall's, same convention CFB
    uses via current_week.py."""
    today = datetime.date.today()
    return today.year if today.month >= 8 else today.year - 1


def run() -> None:
    client = get_client()
    season = _season_year()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    upserts = []
    for week in REGULAR_SEASON_WEEKS:
        resp = requests.get(ESPN_SCOREBOARD_URL, params={"seasontype": 2, "week": week, "year": season}, timeout=30)
        resp.raise_for_status()
        events = resp.json().get("events", [])
        for e in events:
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
                    "updated_at": now,
                }

            upserts.append(
                {
                    "id": _nfl_game_id(e["id"]),
                    "sport": "nfl",
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
        print("No NFL events found.")
        return
    for i in range(0, len(upserts), 500):
        client.table("games").upsert(upserts[i : i + 500], on_conflict="id").execute()
    print(f"Upserted {len(upserts)} NFL game(s) across {len(list(REGULAR_SEASON_WEEKS))} weeks.")


if __name__ == "__main__":
    run()
