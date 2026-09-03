"""
Shared config for the ingestion/modeling package.

Loads the *same* .env.local the Next.js app uses (one env file for the whole
repo) rather than a separate python/.env, so there's only one place to keep
secrets in sync.
"""
from pathlib import Path
import os

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env.local")

CFBD_API_KEY = os.environ.get("CFBD_API_KEY")
ODDS_API_KEY = os.environ.get("ODDS_API_KEY")
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SECRET_KEY = os.environ.get("SUPABASE_SECRET_KEY")

# Optional - the Telegram bot (python/alerts/) degrades to a no-op without
# these, rather than failing. See python/alerts/telegram_bot.py.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")


def require_env() -> None:
    missing = [
        name
        for name, value in [
            ("CFBD_API_KEY", CFBD_API_KEY),
            ("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL),
            ("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY),
        ]
        if not value
    ]
    if missing:
        raise RuntimeError(
            f"Missing required env var(s) in .env.local: {', '.join(missing)}"
        )
