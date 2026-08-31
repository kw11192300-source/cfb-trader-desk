"""
Polls The Odds API for current NCAAF odds (real per-book juice + a wider
book set than CFBD), matches each event to one of our games, and upserts
into odds_api_lines. See team_match.py for the matching logic and
odds_api_client.py for the API client.

One run = one API call = 3 credits (spreads+totals+h2h, us region) — see
python/README.md for the credit-cost table across polling cadences.

Usage:
    python -m cfbd_ingest.sync_odds_api
"""
from __future__ import annotations

import datetime

from . import odds_api_client
from .supabase_client import get_client
from .team_match import match_odds_events_to_games

CHUNK_SIZE = 500


def chunked(items, size=CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _outcome(outcomes: list[dict], name: str) -> dict | None:
    return next((o for o in outcomes if o.get("name") == name), None)


def run() -> None:
    client = get_client()

    # Match against every not-yet-completed game this season, not just the
    # current week — The Odds API returns odds for several weeks out at once.
    year = datetime.date.today().year
    games = (
        client.table("games")
        .select("id,home_team,away_team,start_date")
        .eq("season", year)
        .eq("completed", False)
        .execute()
        .data
    )
    if not games:
        print("No upcoming games in our own games table — nothing to match against.")
        return

    events, usage = odds_api_client.fetch_ncaaf_odds()
    print(f"Fetched {len(events)} events from The Odds API (credits used: {usage['used']}, remaining: {usage['remaining']})")

    matches = match_odds_events_to_games(events, games)
    print(f"Matched {len(matches)}/{len(events)} events to our games")

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    records = []
    for event in events:
        game_id = matches.get(event["id"])
        if game_id is None:
            continue
        home_team, away_team = event["home_team"], event["away_team"]
        for bm in event.get("bookmakers", []):
            markets = {m["key"]: m for m in bm.get("markets", [])}
            spreads = markets.get("spreads", {}).get("outcomes", [])
            totals = markets.get("totals", {}).get("outcomes", [])
            h2h = markets.get("h2h", {}).get("outcomes", [])

            home_spread_o = _outcome(spreads, home_team)
            away_spread_o = _outcome(spreads, away_team)
            over_o = _outcome(totals, "Over")
            under_o = _outcome(totals, "Under")
            home_ml_o = _outcome(h2h, home_team)
            away_ml_o = _outcome(h2h, away_team)

            records.append(
                {
                    "game_id": game_id,
                    "bookmaker": bm["key"],
                    "bookmaker_title": bm["title"],
                    "home_spread": home_spread_o.get("point") if home_spread_o else None,
                    "home_spread_price": home_spread_o.get("price") if home_spread_o else None,
                    "away_spread": away_spread_o.get("point") if away_spread_o else None,
                    "away_spread_price": away_spread_o.get("price") if away_spread_o else None,
                    "total": over_o.get("point") if over_o else (under_o.get("point") if under_o else None),
                    "over_price": over_o.get("price") if over_o else None,
                    "under_price": under_o.get("price") if under_o else None,
                    "home_moneyline": home_ml_o.get("price") if home_ml_o else None,
                    "away_moneyline": away_ml_o.get("price") if away_ml_o else None,
                    "book_last_update": bm.get("last_update"),
                    "fetched_at": now,
                }
            )

    if not records:
        print("No bookmaker rows to write (no matched events had odds).")
        return

    for batch in chunked(records):
        client.table("odds_api_lines").upsert(batch, on_conflict="game_id,bookmaker").execute()
    print(f"Upserted {len(records)} (game, bookmaker) rows into odds_api_lines")


if __name__ == "__main__":
    run()
