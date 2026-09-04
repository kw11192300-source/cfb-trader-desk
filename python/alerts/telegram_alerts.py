"""
Outbound "good play" alerts — deliberately wired to the ONE validated
signal this project has (predict_week1.py's top-15-by-edge week-1 FBS-vs-FBS
strategy, 74% ATS 2016-2024, 80% on 2025), not the steam/line-movement
model, which is still explicitly parked as "promising, not yet trustworthy"
(concentrated in 2024-2025, no edge at all in 2022-2023). Alerting on an
unvalidated signal would be a real regression from this project's whole
"never trust anything unvalidated" discipline - when the movement model
earns its way to "trustworthy," this is the place to add a second alert
source, not before.

Dedup: predictions.alert_sent_at. A pick that's still in the top-15 pool on
a later predict_week1.py run (market hasn't moved much, or ran again same
day) does NOT re-alert - only genuinely new top-15 picks do.
"""
from __future__ import annotations

import datetime

from . import telegram_bot


def send_new_edge_alerts(client, model_version: str, records: list[dict], top_game_ids: set[int]) -> int:
    """`records` is predict_week1.py's own list of upserted prediction rows
    (game_id, predicted_margin, market_spread, edge_spread, rationale,
    suggested_units) - reused as-is so the alert text and the site's own
    rationale never drift apart. `top_game_ids` is this run's top-N pool.
    Returns how many alerts were actually sent (0 if Telegram isn't
    configured - this must never be the reason a predict run fails)."""
    if not telegram_bot.is_configured() or not top_game_ids:
        return 0

    existing = (
        client.table("predictions")
        .select("game_id,alert_sent_at")
        .eq("model_version", model_version)
        .in_("game_id", list(top_game_ids))
        .execute()
    )
    already_alerted = {row["game_id"] for row in existing.data if row["alert_sent_at"] is not None}
    to_alert = [gid for gid in top_game_ids if gid not in already_alerted]
    if not to_alert:
        return 0

    records_by_game = {r["game_id"]: r for r in records}
    sent_ids: list[int] = []
    for game_id in to_alert:
        r = records_by_game.get(game_id)
        if r is None:
            continue
        edge = abs(r["edge_spread"])
        text = f"\U0001f3c8 New edge ({edge:.1f} pts)\n\n{r['rationale']}"
        if r.get("suggested_units"):
            text += f"\n\nSuggested size: {r['suggested_units']:.1f}u"
        try:
            telegram_bot.send_message(text)
            sent_ids.append(game_id)
        except Exception as e:  # best-effort - one failed send shouldn't block the rest or fail the run
            print(f"Telegram alert failed for game {game_id}: {e}")

    if sent_ids:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        for i in range(0, len(sent_ids), 500):
            batch = sent_ids[i : i + 500]
            client.table("predictions").update({"alert_sent_at": now}).eq("model_version", model_version).in_("game_id", batch).execute()

    return len(sent_ids)


def send_watchlist_confirmation_alerts(client, model_version: str, rows: list[dict]) -> int:
    """watchlist.py's second signal - explicitly NOT the validated week-1
    strategy above, and labeled as such in the message text itself so it's
    never confused for one. Fires once a candidate's CURRENT line has moved
    toward the model's side by watchlist.CONFIRM_MOVE_THRESHOLD since it
    was first flagged (reference_spread) - see schema.sql's watchlist_picks
    docstring for the backtest finding this is based on (post-week-1: 64%
    ATS when confirmed vs. 41% when not, n=74, 2016-2025 - real but a much
    thinner, more exploratory result than the week-1 strategy's 74%/150).

    `rows` are watchlist_picks rows (dicts) that just crossed the
    confirmation threshold this run and haven't been alerted yet - dedup
    itself (alert_sent_at) is the caller's job, same division of labor as
    send_new_edge_alerts. Returns how many alerts actually sent."""
    if not telegram_bot.is_configured() or not rows:
        return 0

    sent_ids: list[int] = []
    for r in rows:
        move = r["move_toward_pick"]
        text = (
            f"\U0001f440 Watchlist confirmed ({move:+.1f} pt move)\n\n"
            f"{r['rationale']}\n\n"
            f"Line opened at {r['reference_spread']:+.1f}, now {r['current_spread']:+.1f} - moving your way.\n\n"
            f"Exploratory in-season signal, NOT the validated week-1 strategy - see /watchlist for the real numbers before sizing this."
        )
        try:
            telegram_bot.send_message(text)
            sent_ids.append(r["id"])
        except Exception as e:  # best-effort - one failed send shouldn't block the rest or fail the run
            print(f"Telegram watchlist alert failed for row {r['id']}: {e}")

    if sent_ids:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        for i in range(0, len(sent_ids), 500):
            batch = sent_ids[i : i + 500]
            client.table("watchlist_picks").update({"alert_sent_at": now}).in_("id", batch).execute()

    return len(sent_ids)
