"""Keep the college basketball movement board fresh, from the exchange's own workflow.

The board (cbb_game_board, python -m cbb_model.board refresh) is what the movement model scores: where each line should close, and the plays worth flagging. It used to be rescored only when a
separate cron-job.org timer called /api/cron/cbb-board, and when that timer lapsed the board went hours stale and the picks tracker and the Open Mover firm stopped getting calls. The
exchange round workflow now runs this after every round: it rescores the board when the last scoring is more than MAX_AGE_MIN minutes old and does nothing otherwise, so the board is
refreshed about every half hour while the round keeps its five-minute rhythm. It never raises: a failed refresh leaves the old board in place and the next round tries again.

    python -m exchange.boardkeep [--max-age 25] [--days 8]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

MAX_AGE_MIN = 25
DAYS = 8


def board_age(client, now: datetime) -> timedelta | None:
    rows = client.table("cbb_game_board").select("updated_at").order("updated_at", desc=True).limit(1).execute().data or []
    if not rows:
        return None
    return now - datetime.fromisoformat(rows[0]["updated_at"].replace("Z", "+00:00"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age", type=int, default=MAX_AGE_MIN, help="minutes: rescore when the board is older than this")
    ap.add_argument("--days", type=int, default=DAYS)
    a = ap.parse_args()
    try:
        from cfbd_ingest.supabase_client import get_client

        from cbb_model import board_live

        now = datetime.now(timezone.utc)
        age = board_age(get_client(), now)
        if age is not None and age < timedelta(minutes=a.max_age):
            print(f"board is {int(age.total_seconds() // 60)} min old: left alone")
            return
        print("board is " + ("missing" if age is None else f"{int(age.total_seconds() // 60)} min old") + ": rescoring", flush=True)
        board_live.refresh(days=a.days)
    except SystemExit as e:  # the refresh exits when there is nothing to score
        print(f"board not refreshed: {e}")
    except Exception as e:
        print(f"board not refreshed: {str(e)[:200]}")


if __name__ == "__main__":
    main()
