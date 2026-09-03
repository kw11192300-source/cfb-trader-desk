"""
Telegram alerts tied to specific logged bets - not to be confused with
alerts/telegram_alerts.py (new-edge alerts, tied to predictions, not bets).

Two kinds, both dedup'd via a `_sent_at` column on `bets` (same pattern as
predictions.alert_sent_at) so each bet gets at most one of each ever:
  1. Kickoff reminder - a pending bet whose game kicks off in the next
     ~5-20 minutes gets one heads-up message.
  2. Result alert - a bet whose game has finished gets a win/loss/push
     message with the real graded profit.

Usage:
    python -m alerts.bet_alerts
"""
from __future__ import annotations

import datetime

from cfbd_ingest.supabase_client import get_client

from . import telegram_bot

# Wide enough to survive this cron's own ~5min imprecision (see
# poll-telegram.yml's comment on the same issue) without a bet's kickoff
# window ever landing between two runs and getting skipped entirely.
KICKOFF_WINDOW_MINUTES = (5, 20)


def _american_to_decimal(odds: int) -> float:
    return 100 / abs(odds) + 1 if odds < 0 else odds / 100 + 1


def _grade_bet(bet: dict, game: dict) -> tuple[str, float | None]:
    """Mirrors src/lib/data.ts's gradeBet() exactly - keep both in sync if
    either changes. margin > 0 win, < 0 loss, == 0 push; spread convention
    throughout (negative = favored), same as the rest of this project."""
    if not game["completed"] or game["home_points"] is None or game["away_points"] is None:
        return "pending", None

    if bet["market"] == "total":
        total = game["home_points"] + game["away_points"]
        margin = (total - bet["line"]) if bet["side"] == "over" else (bet["line"] - total)
    elif bet["market"] == "moneyline":
        home_won = game["home_points"] > game["away_points"]
        side_is_home = bet["side"] == game["home_team"]
        margin = 1.0 if (home_won if side_is_home else not home_won) else -1.0
    else:
        side_is_home = bet["side"] == game["home_team"]
        actual_margin_for_side = (
            (game["home_points"] - game["away_points"]) if side_is_home else (game["away_points"] - game["home_points"])
        )
        margin = actual_margin_for_side + bet["line"]

    if margin > 0:
        return "win", bet["stake"] * (_american_to_decimal(bet["odds"]) - 1)
    if margin < 0:
        return "loss", -bet["stake"]
    return "push", 0.0


def _fmt_bet_line(bet: dict) -> str:
    if bet["market"] == "moneyline":
        return f"{bet['side']} ML"
    if bet["market"] == "total":
        return f"{bet['side']} {bet['line']:.1f}"
    return f"{bet['side']} {bet['line']:+.1f}"


def send_kickoff_reminders(client) -> int:
    now = datetime.datetime.now(datetime.timezone.utc)
    lo = now + datetime.timedelta(minutes=KICKOFF_WINDOW_MINUTES[0])
    hi = now + datetime.timedelta(minutes=KICKOFF_WINDOW_MINUTES[1])

    bets = client.table("bets").select("id,game_id,side,line,market,stake,sportsbook,kickoff_reminder_sent_at").execute().data
    pending_reminder = [b for b in bets if b["kickoff_reminder_sent_at"] is None]
    if not pending_reminder:
        return 0

    game_ids = list({b["game_id"] for b in pending_reminder})
    games = client.table("games").select("id,home_team,away_team,start_date,completed").in_("id", game_ids).execute().data
    game_by_id = {g["id"]: g for g in games}

    sent = 0
    for bet in pending_reminder:
        game = game_by_id.get(bet["game_id"])
        if not game or game["completed"]:
            continue
        start = datetime.datetime.fromisoformat(game["start_date"].replace("Z", "+00:00"))
        if not (lo <= start <= hi):
            continue
        text = (
            f"⏰ Kickoff soon: {game['away_team']} @ {game['home_team']}\n"
            f"Your bet: {_fmt_bet_line(bet)}, {bet['stake']:g}u"
            + (f" on {bet['sportsbook']}" if bet.get("sportsbook") else "")
        )
        try:
            telegram_bot.send_message(text)
            client.table("bets").update({"kickoff_reminder_sent_at": now.isoformat()}).eq("id", bet["id"]).execute()
            sent += 1
        except Exception as e:  # best-effort - one failed send shouldn't block the rest
            print(f"Kickoff reminder failed for bet {bet['id']}: {e}")
    return sent


def send_result_alerts(client) -> int:
    bets = client.table("bets").select(
        "id,game_id,side,line,market,odds,stake,sportsbook,result_alert_sent_at"
    ).execute().data
    pending_result = [b for b in bets if b["result_alert_sent_at"] is None]
    if not pending_result:
        return 0

    game_ids = list({b["game_id"] for b in pending_result})
    games = client.table("games").select("id,home_team,away_team,completed,home_points,away_points").in_("id", game_ids).execute().data
    game_by_id = {g["id"]: g for g in games}

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    emoji = {"win": "✅", "loss": "❌", "push": "➡️"}
    sent = 0
    for bet in pending_result:
        game = game_by_id.get(bet["game_id"])
        if not game:
            continue
        status, profit = _grade_bet(bet, game)
        if status == "pending":
            continue
        text = (
            f"{emoji[status]} {status.upper()}: {_fmt_bet_line(bet)} ({game['away_team']} @ {game['home_team']})\n"
            f"Final: {game['away_points']}-{game['home_points']}. "
            + (f"{profit:+.2f}u" if profit is not None else "")
        )
        try:
            telegram_bot.send_message(text)
            client.table("bets").update({"result_alert_sent_at": now}).eq("id", bet["id"]).execute()
            sent += 1
        except Exception as e:
            print(f"Result alert failed for bet {bet['id']}: {e}")
    return sent


def run() -> None:
    if not telegram_bot.is_configured():
        print("Telegram not configured - nothing to do.")
        return
    client = get_client()
    n_kickoff = send_kickoff_reminders(client)
    n_result = send_result_alerts(client)
    print(f"Sent {n_kickoff} kickoff reminder(s), {n_result} result alert(s).")


if __name__ == "__main__":
    run()
