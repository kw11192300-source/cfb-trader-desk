"""
Sharp-book steam alert - a THIRD, distinct signal from predict_week1.py and
watchlist.py. Not model-based at all: no prediction, no edge computation,
just "Pinnacle's own line moved a meaningful amount from where we first saw
it." The premise (not yet backtested - see schema.sql's sharp_steam_alerts
docstring): Pinnacle is a market-making sharp book that only reprices on
real money/information, unlike square retail books that can move on public
betting volume alone - so a real Pinnacle move is itself a signal worth a
look, independent of whatever our own model thinks.

Reads Pinnacle's history out of line_snapshots (provider='pinnacle',
written by sync_odds_api.py - see that module's SHARP_PROVIDER_KEY), NOT
odds_api_lines - the latter is current-state-only and gets overwritten
every poll, so it can't show movement over time.

No model to train and no feature-building pass, unlike watchlist.py - this
is cheap DB-only work every time, so unlike predict_week1.py/watchlist.py
there's no reason to split this into a slow "discover" and fast "confirm"
script. Safe to run as often as sync_odds_api.py itself updates (every 6h
on the free Odds API tier right now - see python/README.md; tightening
that cadence is what actually makes this catch a real steam move instead
of a coarse before/after snapshot).

Usage:
    python -m modeling.sharp_steam
"""
from __future__ import annotations

import datetime

from cfbd_ingest.supabase_client import get_client

STEAM_MOVE_THRESHOLD = 1.5  # points of Pinnacle movement to alert on - a judgment call, not fit to data (no backtest exists yet)
LOOKAHEAD_DAYS = 9  # only watch games this close - matches watchlist.py's WATCH_WINDOW_DAYS


def run() -> None:
    client = get_client()
    now = datetime.datetime.now(datetime.timezone.utc)
    horizon = now + datetime.timedelta(days=LOOKAHEAD_DAYS)

    games = (
        client.table("games")
        .select("id,home_team,away_team,start_date")
        .eq("sport", "cfb")
        .eq("completed", False)
        .gt("start_date", now.isoformat())
        .lte("start_date", horizon.isoformat())
        .execute()
        .data
    )
    if not games:
        print("No upcoming CFB games in the lookahead window.")
        return
    games_by_id = {g["id"]: g for g in games}
    game_ids = list(games_by_id)

    snapshots = (
        client.table("line_snapshots")
        .select("game_id,spread,captured_at")
        .eq("provider", "pinnacle")
        .in_("game_id", game_ids)
        .order("captured_at")
        .execute()
        .data
    )
    if not snapshots:
        print("No Pinnacle snapshots yet for any upcoming game - nothing to compare.")
        return

    by_game: dict[int, list[dict]] = {}
    for s in snapshots:
        if s["spread"] is None:
            continue
        by_game.setdefault(s["game_id"], []).append(s)

    existing = client.table("sharp_steam_alerts").select("id,game_id,alert_sent_at").in_("game_id", game_ids).execute().data
    existing_by_game = {r["game_id"]: r for r in existing}

    new_rows = []
    update_rows = []
    confirmed_rows = []
    for gid, rows in by_game.items():
        if len(rows) < 2:
            continue  # only one snapshot so far - nothing to compare against yet
        reference = rows[0]
        current = rows[-1]
        move = current["spread"] - reference["spread"]
        existing_row = existing_by_game.get(gid)

        if existing_row is None:
            new_rows.append(
                {
                    "game_id": gid,
                    "reference_spread": reference["spread"],
                    "reference_captured_at": reference["captured_at"],
                    "current_spread": current["spread"],
                    "move": move,
                }
            )
            if abs(move) >= STEAM_MOVE_THRESHOLD:
                confirmed_rows.append(
                    {
                        "game_id": gid,
                        "reference_spread": reference["spread"],
                        "current_spread": current["spread"],
                        "move": move,
                    }
                )
            continue

        if existing_row["alert_sent_at"] is not None:
            continue  # already fired for this game - leave it alone

        update_rows.append({"id": existing_row["id"], "current_spread": current["spread"], "move": move})
        if abs(move) >= STEAM_MOVE_THRESHOLD:
            confirmed_rows.append(
                {
                    "id": existing_row["id"],
                    "game_id": gid,
                    "reference_spread": reference["spread"],
                    "current_spread": current["spread"],
                    "move": move,
                }
            )

    if new_rows:
        client.table("sharp_steam_alerts").insert(new_rows).execute()
        print(f"Tracking {len(new_rows)} new game(s) for Pinnacle movement.")

    for u in update_rows:
        client.table("sharp_steam_alerts").update({"current_spread": u["current_spread"], "move": u["move"]}).eq("id", u["id"]).execute()
    if update_rows:
        print(f"Refreshed {len(update_rows)} tracked game(s).")

    # A row created THIS run (new_rows) has no `id` from the insert response
    # here - re-fetch ids for any confirmed-on-discovery rows before
    # alerting, rather than threading .execute() response data through.
    to_alert = [r for r in confirmed_rows if "id" in r]
    newly_confirmed_games = [r["game_id"] for r in confirmed_rows if "id" not in r]
    if newly_confirmed_games:
        refetched = (
            client.table("sharp_steam_alerts")
            .select("id,game_id,reference_spread,current_spread,move")
            .in_("game_id", newly_confirmed_games)
            .is_("alert_sent_at", "null")
            .execute()
            .data
        )
        to_alert.extend(refetched)

    if to_alert:
        from alerts.telegram_alerts import send_sharp_steam_alerts

        n = send_sharp_steam_alerts(client, to_alert, games_by_id)
        if n:
            print(f"Sent {n} sharp steam alert(s).")


if __name__ == "__main__":
    run()
