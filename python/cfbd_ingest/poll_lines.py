"""
Frequent (every 1-15 min, your call) line poll: fetches the current week's
betting lines and (a) upserts betting_lines with the latest values (the
"current state" table the UI reads) and (b) appends a row per (game,
provider) to line_snapshots (append-only, timestamped) — that history is
what the CLV/line-movement model trains on.

Deliberately PREMATCH ONLY: a "week" runs Thu/Fri through Sat/Sun, so by
Saturday some of that week's games have already kicked off while others
haven't. CFBD's lines feed doesn't stop returning a number for a game in
progress - some books post live/in-play prices that behave completely
differently from a pregame spread (they track score and time remaining,
not team strength). Reading those into betting_lines would silently turn
"the market's current number" and any CLV computed off it into a live
in-play price once a game goes live - excluded here by dropping any game
whose kickoff has already passed before this run even asks CFBD for it,
so betting_lines simply freezes at the last real prematch value once a
game starts, exactly as intended. See sync_odds_api.py's identical fix.

One CFBD call per run regardless of how many games are in the week.

Usage:
    python -m cfbd_ingest.poll_lines
"""
from __future__ import annotations

import datetime

from . import cfbd_client as cfbd
from .config import require_env
from .current_week import get_current_week
from .supabase_client import get_client

CHUNK_SIZE = 500


def chunked(items, size=CHUNK_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def run() -> None:
    require_env()
    current = get_current_week()
    if current is None:
        print("No upcoming/in-progress game found in our own games table — nothing to poll.")
        return
    season, week, season_type = current
    print(f"Polling lines for {season} week {week} ({season_type})...")

    client = get_client()
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    known = (
        client.table("games")
        .select("id")
        .eq("season", season)
        .eq("week", week)
        .eq("season_type", season_type)
        .gt("start_date", now_iso)  # prematch only - see module docstring
        .execute()
    )
    known_game_ids = {row["id"] for row in known.data}

    games = cfbd.fetch_lines(season, season_type=season_type, week=week)
    games = [g for g in games if g["id"] in known_game_ids]

    now = now_iso
    current_rows = []
    snapshot_rows = []
    for g in games:
        for line in g.get("lines", []):
            if line.get("spread") is None and line.get("overUnder") is None:
                continue
            current_rows.append(
                {
                    "game_id": g["id"],
                    "provider": line["provider"],
                    "spread": line.get("spread"),
                    "spread_open": line.get("spreadOpen"),
                    "over_under": line.get("overUnder"),
                    "over_under_open": line.get("overUnderOpen"),
                    "home_moneyline": line.get("homeMoneyline"),
                    "away_moneyline": line.get("awayMoneyline"),
                    "formatted_spread": line.get("formattedSpread"),
                    "fetched_at": now,
                }
            )
            snapshot_rows.append(
                {
                    "game_id": g["id"],
                    "provider": line["provider"],
                    "spread": line.get("spread"),
                    "over_under": line.get("overUnder"),
                    "home_moneyline": line.get("homeMoneyline"),
                    "away_moneyline": line.get("awayMoneyline"),
                    "captured_at": now,
                }
            )

    if not current_rows:
        print("  no lines returned for this week yet.")
        return

    for batch in chunked(current_rows):
        client.table("betting_lines").upsert(batch, on_conflict="game_id,provider").execute()
    for batch in chunked(snapshot_rows):
        client.table("line_snapshots").insert(batch).execute()

    print(f"  wrote {len(current_rows)} current lines, {len(snapshot_rows)} snapshot rows.")


if __name__ == "__main__":
    run()
