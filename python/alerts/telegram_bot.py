"""
Thin wrapper around Telegram's Bot API — no framework, no webhook. Both
sides of the "message stuff" (outbound edge alerts, inbound bet logging)
are driven by a GitHub Actions cron calling this on a schedule, the same
shape as poll_lines.py, rather than a webhook needing a public always-on
server. Telegram's Bot API supports both models; polling is the one that
fits this project without pulling the Vercel deploy forward as a hard
dependency.

Setup (one-time, by hand — nothing here can do this for you):
  1. Message @BotFather on Telegram, send /newbot, follow the prompts.
     You'll get back a bot token like "123456:ABC-DEF...".
  2. Message your new bot anything (e.g. "hi") so Telegram has a chat to
     reply to.
  3. Visit https://api.telegram.org/bot<token>/getUpdates in a browser (or
     curl it) — your message shows up with a "chat":{"id": ...} — that
     number is TELEGRAM_CHAT_ID.
  4. Add both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env.local (local
     runs) AND as GitHub Actions repo secrets (scheduled runs) - same
     pattern as every other secret this project uses.

Everything here is deliberately optional: is_configured() gates every real
call, and callers are expected to treat a missing config as "this feature
just isn't turned on yet," not an error - Telegram must never be a reason
a predict_week1.py run (or anything else) fails.
"""
from __future__ import annotations

import requests

from cfbd_ingest.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

API_BASE = "https://api.telegram.org/bot{token}/{method}"
HTTP_TIMEOUT = 15  # seconds - our own request timeout, unrelated to Telegram's long-poll timeout param below


def is_configured() -> bool:
    return bool(TELEGRAM_BOT_TOKEN) and bool(TELEGRAM_CHAT_ID)


def send_message(text: str) -> None:
    """Sends `text` to TELEGRAM_CHAT_ID. Raises if not configured or if the
    Telegram API call fails - callers that want alerts to be best-effort
    (e.g. predict_week1.py's edge alerts) should catch around this
    themselves rather than have it silently swallow failures here."""
    if not is_configured():
        raise RuntimeError("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)")
    url = API_BASE.format(token=TELEGRAM_BOT_TOKEN, method="sendMessage")
    resp = requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text}, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    body = resp.json()
    if not body.get("ok"):
        raise RuntimeError(f"Telegram sendMessage failed: {body}")


def get_updates(offset: int | None = None) -> list[dict]:
    """Fetches new messages since `offset` (Telegram's own update_id
    cursor - pass the last-seen update_id + 1; None fetches from whatever
    Telegram still has buffered, only relevant on a first-ever run).
    timeout=0 (no long-poll) - this is called from a short-lived cron job,
    not a persistent process, so we want an immediate response, not Telegram
    holding the connection open waiting for a new message."""
    if not is_configured():
        raise RuntimeError("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)")
    url = API_BASE.format(token=TELEGRAM_BOT_TOKEN, method="getUpdates")
    params: dict[str, int] = {"timeout": 0}
    if offset is not None:
        params["offset"] = offset
    resp = requests.get(url, params=params, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    body = resp.json()
    if not body.get("ok"):
        raise RuntimeError(f"Telegram getUpdates failed: {body}")
    return body.get("result", [])
