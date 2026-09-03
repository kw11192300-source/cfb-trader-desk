"""
Inbound half of the "message stuff": polls Telegram for new messages sent
to the bot, parses each as a bet (see bet_parser.py), logs it to `bets`,
and replies confirming what was logged (or explaining why it couldn't be).

Polling, not a webhook - runs from a GitHub Actions cron (see
.github/workflows/poll-telegram.yml), same shape as poll_lines.py. Cursor
state (Telegram's own update_id, so a restart never reprocesses or drops a
message) lives in the tiny `bot_state` table, not a local file - has to
survive between short-lived CI runs.

Usage:
    python -m alerts.log_bets_from_telegram
"""
from __future__ import annotations

import datetime

import pandas as pd
from postgrest.exceptions import APIError

from cfbd_ingest.config import TELEGRAM_CHAT_ID
from cfbd_ingest.current_week import get_current_week
from cfbd_ingest.supabase_client import get_client
from modeling.features import BOOK_PREFERENCE

from . import telegram_bot
from .bet_parser import Candidate, parse_bet_message

STATE_KEY = "telegram_last_update_id"


def _get_last_update_id(client) -> int | None:
    res = client.table("bot_state").select("value").eq("key", STATE_KEY).limit(1).execute()
    if not res.data:
        return None
    return res.data[0]["value"].get("id")


def _set_last_update_id(client, update_id: int) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    client.table("bot_state").upsert({"key": STATE_KEY, "value": {"id": update_id}, "updated_at": now}, on_conflict="key").execute()


def _current_lines(client, game_ids: list[int]) -> dict[int, dict]:
    """Freshest spread+total per game (home-team perspective), same
    book-preference order as everywhere else - see modeling/features.py's
    BOOK_PREFERENCE."""
    if not game_ids:
        return {}
    rows = client.table("betting_lines").select("game_id,provider,spread,over_under,fetched_at").in_("game_id", game_ids).execute().data
    if not rows:
        return {}
    df = pd.DataFrame(rows)
    df["book_rank"] = df["provider"].apply(lambda p: BOOK_PREFERENCE.index(p) if p in BOOK_PREFERENCE else len(BOOK_PREFERENCE))
    df = df.sort_values(["game_id", "book_rank", "fetched_at"], ascending=[True, True, False])
    out: dict[int, dict] = {}
    for game_id, group in df.groupby("game_id"):
        best = group.iloc[0]
        out[int(game_id)] = {
            "spread": None if pd.isna(best["spread"]) else float(best["spread"]),
            "total": None if pd.isna(best["over_under"]) else float(best["over_under"]),
        }
    return out


def _build_candidates(client) -> list[Candidate]:
    """This week's not-yet-completed slate, with current market numbers
    attached - the pool a message could plausibly be about. Deliberately
    not filtered to FBS-only (predict_week1.py's scope) - a user might
    message about any game with lines posted."""
    current = get_current_week()
    if current is None:
        return []
    season, week, season_type = current
    games = (
        client.table("games")
        .select("id,home_team,away_team")
        .eq("season", season)
        .eq("week", week)
        .eq("season_type", season_type)
        .eq("completed", False)
        .execute()
        .data
    )
    if not games:
        return []
    lines = _current_lines(client, [g["id"] for g in games])
    return [
        Candidate(
            game_id=g["id"],
            home_team=g["home_team"],
            away_team=g["away_team"],
            home_market_spread=lines.get(g["id"], {}).get("spread"),
            total=lines.get(g["id"], {}).get("total"),
        )
        for g in games
    ]


def _model_version_for_game(client, game_id: int) -> str | None:
    res = client.table("predictions").select("model_version").eq("game_id", game_id).limit(1).execute()
    return res.data[0]["model_version"] if res.data else None


def _confirmation_text(result, edge_source: str) -> str:
    if result.market == "moneyline":
        head = f"{result.side} ML"
    elif result.market == "total":
        head = f"{result.side} {result.line:.1f}"
    else:
        head = f"{result.side} {result.line:+.1f}"
    text = f"✅ Logged: {head}, {result.stake:g}u @ {result.odds:+d}"
    if result.sportsbook:
        text += f" on {result.sportsbook}"
    text += f" ({edge_source})"
    return text


def run() -> None:
    if not telegram_bot.is_configured():
        print("Telegram not configured - nothing to do.")
        return

    client = get_client()
    last_id = _get_last_update_id(client)
    updates = telegram_bot.get_updates(offset=(last_id + 1) if last_id is not None else None)
    if not updates:
        print("No new Telegram messages.")
        return

    candidates = _build_candidates(client)
    max_update_id = last_id or 0
    logged = 0

    # Every send_message below is best-effort (wrapped, never re-raised) -
    # a Telegram network blip on the REPLY must never stop max_update_id
    # from advancing at the end, or the same message reprocesses (and, for
    # a parsed bet, would double-insert) on the next poll. Caught the hard
    # way: a transient connect-timeout here once already left a real bet
    # logged with bot_state stuck one message behind it. The
    # telegram_update_id unique constraint (see schema.sql) is the second,
    # independent layer - belt and suspenders, since "never re-raise" is
    # only as good as actually never missing a spot.
    for update in updates:
        max_update_id = max(max_update_id, update["update_id"])
        message = update.get("message")
        if not message or "text" not in message:
            continue
        # Ignore anyone/anywhere else - this bot is single-user by design,
        # same trust boundary as every other write path in this project
        # (only the secret key can write; this is that key's human proxy).
        if str(message["chat"]["id"]) != str(TELEGRAM_CHAT_ID):
            continue

        result = parse_bet_message(message["text"], candidates)
        if isinstance(result, str):
            try:
                telegram_bot.send_message(f"⚠️ {result}")
            except Exception as e:
                print(f"Failed to send error reply for update {update['update_id']}: {e}")
            continue

        # A live prediction existing on this game is NOT evidence the bet was
        # actually motivated by it - conflating "this game happens to have a
        # model pick" with "I bet this because of the model" produced two
        # real mislabeled bets in practice (market-motivated bets that
        # happened to also have a model edge, silently tagged 'model').
        # 'market' is the more conservative default absent an explicit tag;
        # model_version is still attached either way, purely for backtest/
        # analytics linkage, independent of what edge_source says.
        edge_source = result.edge_source or "market"
        model_version = _model_version_for_game(client, result.game_id)

        try:
            client.table("bets").insert(
                {
                    "game_id": result.game_id,
                    "model_version": model_version,
                    "market": result.market,
                    "side": result.side,
                    "line": result.line,
                    "odds": result.odds,
                    "stake": result.stake,
                    "sportsbook": result.sportsbook,
                    "edge_source": edge_source,
                    "telegram_update_id": update["update_id"],
                }
            ).execute()
            logged += 1
        except APIError as e:
            if e.code == "23505":  # unique_violation - already logged this exact message, a retry after a prior crash
                print(f"Update {update['update_id']} already logged (retry) - skipping insert, still confirming.")
            else:
                print(f"Failed to insert bet for update {update['update_id']}: {e}")
                continue

        try:
            telegram_bot.send_message(_confirmation_text(result, edge_source))
        except Exception as e:
            print(f"Bet logged but confirmation reply failed for update {update['update_id']}: {e}")

    _set_last_update_id(client, max_update_id)
    print(f"Processed {len(updates)} update(s), logged {logged} bet(s), last_update_id={max_update_id}.")


if __name__ == "__main__":
    run()
