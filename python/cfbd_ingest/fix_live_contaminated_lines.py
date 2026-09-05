"""
One-time repair for lines captured WHILE a game was live, from before
poll_lines.py/sync_odds_api.py were fixed to be prematch-only (see their
module docstrings). Safe to rerun - it's a no-op once nothing's
contaminated. Not wired into any scheduled workflow; run manually.

betting_lines: for any (game, provider) row whose fetched_at is AFTER
that game's kickoff, restore it from the latest line_snapshots row
captured AT OR BEFORE kickoff (line_snapshots is append-only, so the true
last-prematch value is recoverable there even though betting_lines itself
got overwritten). Confirmed live: some early-season games were never
polled until AFTER their own kickoff (the current-week window picked
them up late), so no prematch snapshot exists for them at all - same
"unrecoverable, don't silently serve the wrong number" treatment as
odds_api_lines below: deleted rather than left contaminated.

odds_api_lines: has no snapshot history (see its schema.sql comment), so
a contaminated row there is unrecoverable - deleted outright rather than
silently served as "current." A book that's polled again before this
game (there won't be one, it's already live) would just re-populate it;
otherwise it correctly disappears from that game's odds comparison until
the next game.

Usage:
    python -m cfbd_ingest.fix_live_contaminated_lines
"""
from __future__ import annotations

import datetime

from .supabase_client import get_client


def run() -> None:
    client = get_client()
    year = datetime.date.today().year
    now = datetime.datetime.now(datetime.timezone.utc)

    games = client.table("games").select("id,start_date").eq("season", year).lt("start_date", now.isoformat()).execute().data
    if not games:
        print("No started games this season yet - nothing to check.")
        return
    kickoff_by_game = {g["id"]: datetime.datetime.fromisoformat(g["start_date"].replace("Z", "+00:00")) for g in games}
    game_ids = list(kickoff_by_game.keys())

    # --- betting_lines: restore from line_snapshots where possible ---
    fixed, unrecoverable = 0, 0
    for i in range(0, len(game_ids), 200):
        batch_ids = game_ids[i : i + 200]
        lines = client.table("betting_lines").select("game_id,provider,fetched_at").in_("game_id", batch_ids).execute().data
        contaminated = [
            row for row in lines if datetime.datetime.fromisoformat(row["fetched_at"].replace("Z", "+00:00")) > kickoff_by_game[row["game_id"]]
        ]
        if not contaminated:
            continue
        snaps = (
            client.table("line_snapshots")
            .select("game_id,provider,spread,over_under,home_moneyline,away_moneyline,captured_at")
            .in_("game_id", [r["game_id"] for r in contaminated])
            .order("captured_at", desc=True)
            .execute()
            .data
        )
        for row in contaminated:
            kickoff = kickoff_by_game[row["game_id"]]
            candidates = [
                s
                for s in snaps
                if s["game_id"] == row["game_id"]
                and s["provider"] == row["provider"]
                and datetime.datetime.fromisoformat(s["captured_at"].replace("Z", "+00:00")) <= kickoff
            ]
            if not candidates:
                unrecoverable += 1
                client.table("betting_lines").delete().eq("game_id", row["game_id"]).eq("provider", row["provider"]).execute()
                print(f"  no prematch snapshot for game {row['game_id']} / {row['provider']} - deleted (unrecoverable).")
                continue
            best = candidates[0]  # snaps already sorted captured_at desc
            client.table("betting_lines").update(
                {
                    "spread": best["spread"],
                    "over_under": best["over_under"],
                    "home_moneyline": best["home_moneyline"],
                    "away_moneyline": best["away_moneyline"],
                    "fetched_at": best["captured_at"],
                }
            ).eq("game_id", row["game_id"]).eq("provider", row["provider"]).execute()
            fixed += 1
    print(f"betting_lines: restored {fixed} contaminated row(s), deleted {unrecoverable} unrecoverable (no prematch snapshot on file).")

    # --- odds_api_lines: no history to restore from - delete contaminated rows ---
    deleted = 0
    for i in range(0, len(game_ids), 200):
        batch_ids = game_ids[i : i + 200]
        rows = client.table("odds_api_lines").select("game_id,bookmaker,fetched_at").in_("game_id", batch_ids).execute().data
        for row in rows:
            if datetime.datetime.fromisoformat(row["fetched_at"].replace("Z", "+00:00")) > kickoff_by_game[row["game_id"]]:
                client.table("odds_api_lines").delete().eq("game_id", row["game_id"]).eq("bookmaker", row["bookmaker"]).execute()
                deleted += 1
    print(f"odds_api_lines: deleted {deleted} unrecoverable contaminated row(s).")


if __name__ == "__main__":
    run()
