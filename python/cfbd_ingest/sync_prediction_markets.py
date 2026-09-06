"""
Pulls college football moneyline-equivalent prices from Kalshi and
Polymarket - both fully public APIs, no key/account needed for market
data reads - and matches them to our own `games` table, same general
approach as team_match.py's Odds API matching but UNORDERED: neither
source reliably indicates which side is home vs away (Kalshi's market
order isn't consistent; Polymarket's title order isn't guaranteed
either), so a game is matched by set-equality on {team_a, team_b}
resolved against our schools, with home/away then assigned from OUR
games row - not trusted from the source.

Exploratory / comparison data only - not fed into the model or the
validated week-1 strategy. The point is surfacing where a prediction
market disagrees with the sportsbook consensus, with real liquidity
behind it, as a sharp-money-style signal (see prediction_market_lines'
schema.sql docstring) - the actual signal/alert logic is a follow-up,
this script is just getting the raw data in.

PREMATCH ONLY, same discipline as poll_lines.py/sync_odds_api.py: Kalshi
and Polymarket keep trading a game live once it kicks off, and that
price reacts to the actual score in real time - a completely different
number from a pregame line, and mixing the two in here would be exactly
the bug already fixed on the sportsbook side. Only matches against games
with start_date in the future, so a game's row simply stops updating
(frozen at its last real prematch price) once it starts, instead of
silently becoming a live in-game price.

Usage:
    python -m cfbd_ingest.sync_prediction_markets
"""
from __future__ import annotations

import datetime
import re

from . import kalshi_client, polymarket_client
from .supabase_client import get_client
from .team_match import find_best_school_match

CHUNK_SIZE = 500
# Same tolerance as team_match.py's Odds API matching - kickoff times can
# genuinely disagree by a few hours between sources for games well out.
KICKOFF_TOLERANCE = datetime.timedelta(hours=6)


def chunked(items, size=CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _resolve_school(name: str, cfbd_schools: list[str]) -> str | None:
    """find_best_school_match, with one fallback: Kalshi consistently
    abbreviates every "...State" school to "...St." (Boise St., Oregon
    St., Weber St., ...) while CFBD's names always spell "State" out in
    full - confirmed live, this was the entire cause of ~40% of Kalshi
    events failing to match. Only tried when the raw name doesn't resolve
    on its own, and anchored to the end of the string so it doesn't
    misfire on an unrelated "St." elsewhere in a name (e.g. a genuine
    "Saint ..." school)."""
    match = find_best_school_match(name, cfbd_schools)
    if match:
        return match
    expanded = re.sub(r"\bSt\.$", "State", name.strip())
    if expanded != name:
        return find_best_school_match(expanded, cfbd_schools)
    return None


def _match_events(events: list[dict], games: list[dict]) -> list[dict]:
    """events: [{id, commence_time, team_a, team_a_prob, team_b, team_b_prob,
    volume, liquidity}]. Returns one record per matched game with prob/
    volume/liquidity correctly assigned to home/away using OUR games
    row's own side assignment - never the source's own ordering."""
    cfbd_schools = list({g["home_team"] for g in games} | {g["away_team"] for g in games})

    # (school_a, school_b) as a frozenset -> list of candidate games, so a
    # match doesn't care which side either source called "first".
    games_by_pair: dict[frozenset, list[dict]] = {}
    for g in games:
        games_by_pair.setdefault(frozenset((g["home_team"], g["away_team"])), []).append(g)

    matched = []
    for event in events:
        school_a = _resolve_school(event["team_a"], cfbd_schools)
        school_b = _resolve_school(event["team_b"], cfbd_schools)
        if school_a is None or school_b is None or school_a == school_b:
            continue
        candidates = games_by_pair.get(frozenset((school_a, school_b)), [])
        if not candidates:
            continue
        if not event.get("commence_time"):
            continue
        event_time = datetime.datetime.fromisoformat(event["commence_time"].replace("Z", "+00:00"))
        for g in candidates:
            game_time = datetime.datetime.fromisoformat(g["start_date"].replace("Z", "+00:00"))
            if abs(event_time - game_time) > KICKOFF_TOLERANCE:
                continue
            home_prob = event["team_a_prob"] if school_a == g["home_team"] else event["team_b_prob"]
            away_prob = event["team_b_prob"] if school_a == g["home_team"] else event["team_a_prob"]
            matched.append(
                {
                    "game_id": g["id"],
                    "external_id": event["id"],
                    "home_implied_prob": home_prob,
                    "away_implied_prob": away_prob,
                    "volume": event["volume"],
                    "liquidity": event["liquidity"],
                }
            )
            break
    return matched


def run() -> None:
    client = get_client()
    year = datetime.date.today().year
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    games = (
        client.table("games")
        .select("id,home_team,away_team,start_date")
        .eq("season", year)
        .eq("completed", False)
        .gt("start_date", now_iso)  # prematch only - see module docstring
        .execute()
        .data
    )
    if not games:
        print("No upcoming (not-yet-started) games in our own games table - nothing to match against.")
        return

    print("Fetching Kalshi NCAA football markets...")
    kalshi_events = kalshi_client.group_by_event(kalshi_client.fetch_ncaaf_game_markets())
    print(f"  {len(kalshi_events)} game-shaped events.")

    print("Fetching Polymarket CFB events...")
    poly_events = polymarket_client.normalize_game_events(polymarket_client.fetch_ncaaf_events())
    print(f"  {len(poly_events)} game-shaped events.")

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    records = []
    for source, events in [("kalshi", kalshi_events), ("polymarket", poly_events)]:
        matched = _match_events(events, games)
        print(f"  matched {len(matched)}/{len(events)} {source} events to our games.")
        for m in matched:
            records.append({**m, "source": source, "fetched_at": now})

    if not records:
        print("Nothing matched - no rows written.")
        return

    for batch in chunked(records):
        client.table("prediction_market_lines").upsert(batch, on_conflict="game_id,source").execute()
    print(f"Wrote {len(records)} prediction-market row(s).")


if __name__ == "__main__":
    run()
