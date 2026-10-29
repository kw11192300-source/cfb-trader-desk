"""python -m exchange init | ratings | round | live | status | reset --yes   (add --local to use the JSON file instead of Supabase)"""
from __future__ import annotations

import argparse

from . import engine
from .espn import SPORTS
from .store import FileStore, SbStore


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["init", "ratings", "round", "live", "status", "reset", "audit"])
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--sports", default=",".join(SPORTS))
    ap.add_argument("--days", type=int, default=420)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--yes", action="store_true", help="reset: confirm that every trade and record should be wiped")
    ap.add_argument("--ticks", type=int, default=engine.TICKS)
    ap.add_argument("--every", type=int, default=120, help="live: seconds between rounds")
    a = ap.parse_args()
    store = FileStore() if a.local else SbStore()
    sports = a.sports.split(",")
    if a.cmd == "init":
        engine.init(store)
        print("roster ready")
    elif a.cmd == "audit":
        from . import audit

        audit.main(store)
    elif a.cmd == "reset":
        if not a.yes:
            raise SystemExit("reset wipes every trade, game, snapshot and trader record; add --yes to confirm")
        engine.reset(store)
        print("exchange reset: no trades, every trader back to its starting bankroll")
    elif a.cmd == "ratings":
        engine.fit_ratings(store, sports, a.days)
    elif a.cmd == "round":
        for _ in range(a.rounds):
            engine.run_round(store, sports, ticks=a.ticks)
    elif a.cmd == "live":  # keeps going on this machine until stopped: a round every --every seconds
        import time

        while True:
            engine.run_round(store, sports, ticks=a.ticks)
            time.sleep(a.every)
    else:
        mem = sorted(store.rows("ex_members"), key=lambda m: -m.get("equity", m["cash"]))
        for m in mem:
            s = m["stats"]
            print(f"{m['id']:<14} equity {m.get('equity', m['cash']):8.2f}  realized {m['realized']:+7.2f}  open {m.get('open_risk', 0):6.2f}  maker/taker trades {s['n_maker']}/{s['n_taker']}")


main()
