"""python -m exchange.agents pack | catalog | backtest FILE | publish SYNDICATE FILE --notes TEXT | refit SYNDICATE|all | report SYNDICATE   (add --local for the JSON store)"""
from __future__ import annotations

import argparse
from pathlib import Path

from ..store import FileStore, SbStore
from . import backtest as bt
from . import manage
from .pack import PACK_DIR, catalog


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pack", "catalog", "backtest", "publish", "refit", "report"])
    ap.add_argument("a", nargs="?")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--notes", default="")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--skip-backtest", action="store_true")
    ap.add_argument("--sports", default="")
    ap.add_argument("--folds", type=int, default=3)
    a = ap.parse_args()
    store = FileStore() if a.local else SbStore()
    sports = a.sports.split(",") if a.sports else None
    if a.cmd == "pack":
        manage.build_pack(store)
    elif a.cmd == "catalog":
        print(catalog())
    elif a.cmd == "backtest":
        if not (PACK_DIR / "espn_nba.pkl").exists():
            manage.build_pack(store)
        print(bt.table(bt.run(Path(a.a).read_text(encoding="utf-8"), sports=sports, folds=a.folds)))
    elif a.cmd == "publish":
        manage.publish(store, a.a, a.b, a.notes, a.skip_backtest)
    elif a.cmd == "refit":
        for sid in ([x["id"] for x in store.rows("ex_syndicates") if x["engine"] == "agent"] if a.a == "all" else [a.a]):
            manage.refit(store, sid)
    else:
        manage.report(store, a.a)


main()
