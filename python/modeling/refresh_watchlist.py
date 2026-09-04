"""
Lightweight watchlist refresh - the fast half of watchlist.py, same split
as refresh_edges.py is to predict_week1.py and for the same reason.

watchlist.py does two genuinely different things on one schedule:
(1) find NEW candidates - needs a full model retrain + build_live_features
    pass (11+ seasons of history, expanding rating fits) - slow, and barely
    changes hour to hour (team ratings don't move that fast) - runs every
    4h via watchlist.yml.
(2) check whether the CURRENT market line has moved far enough from each
    active pick's fixed reference_spread to confirm it - cheap (one
    betting_lines read per game, no ML, no feature rebuild), and the one
    that actually needs to be fresh, since a line can move and move back
    within a few hours and a slow scan would simply never see it.

This script is just (2). Safe to run every ~15 minutes, matching
poll-lines.yml's own cadence - there's no point checking more often than
the market data itself updates. Never creates new watchlist rows or
retrains anything.

Usage:
    python -m modeling.refresh_watchlist
"""
from __future__ import annotations

import datetime

from cfbd_ingest.supabase_client import get_client

from .watchlist import CONFIRM_MOVE_THRESHOLD, MODEL_VERSION, _current_market_line


def run() -> None:
    client = get_client()
    now = datetime.datetime.now(datetime.timezone.utc)

    active = (
        client.table("watchlist_picks")
        .select("id,game_id,pick_home,reference_spread,rationale")
        .eq("model_version", MODEL_VERSION)
        .is_("alert_sent_at", "null")
        .execute()
        .data
    )
    if not active:
        print("No active (un-alerted) watchlist rows.")
        return

    game_ids = [r["game_id"] for r in active]
    games = client.table("games").select("id,start_date,completed").in_("id", game_ids).execute().data
    # A game that's already kicked off (or completed) can't be confirmed
    # into a bet anymore - leave its row alone, it just quietly ages out.
    still_upcoming = {
        g["id"] for g in games if not g["completed"] and datetime.datetime.fromisoformat(g["start_date"].replace("Z", "+00:00")) > now
    }
    active = [r for r in active if r["game_id"] in still_upcoming]
    if not active:
        print("No active watchlist rows still upcoming.")
        return

    current_lines = _current_market_line(client, [r["game_id"] for r in active])
    update_rows = []
    confirmed_rows = []
    for r in active:
        cur = current_lines.get(r["game_id"])
        if cur is None:
            continue  # no current line on file for this game yet - leave its stored row untouched
        ref = r["reference_spread"]
        # Pick side is fixed at discovery time (watchlist.py never
        # changes it once a row exists) - same direction convention as
        # watchlist.py's own confirmation check.
        move = (ref - cur) if r["pick_home"] else (cur - ref)
        update_rows.append({"id": r["id"], "current_spread": float(cur), "move_toward_pick": float(move)})
        if move >= CONFIRM_MOVE_THRESHOLD:
            confirmed_rows.append(
                {"id": r["id"], "rationale": r["rationale"], "reference_spread": ref, "current_spread": float(cur), "move_toward_pick": float(move)}
            )

    if not update_rows:
        print("No active watchlist rows have a current market line to check against.")
        return

    for u in update_rows:
        client.table("watchlist_picks").update({"current_spread": u["current_spread"], "move_toward_pick": u["move_toward_pick"]}).eq(
            "id", u["id"]
        ).execute()
    print(f"Refreshed {len(update_rows)} active watchlist row(s).")

    if confirmed_rows:
        from alerts.telegram_alerts import send_watchlist_confirmation_alerts  # local import - avoid a hard dependency at module load

        n = send_watchlist_confirmation_alerts(client, MODEL_VERSION, confirmed_rows)
        if n:
            print(f"Sent {n} watchlist confirmation alert(s).")


if __name__ == "__main__":
    run()
