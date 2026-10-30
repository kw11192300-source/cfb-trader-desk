"""Track record of sharp pile-ups: when the sharp accounts' combined (sharpness-weighted) position on a line reaches a size, what happens to someone who follows it?

Each round the sharp-weighted net position on every line is worked out (each trader's contracts times its sharpness in that sport, long positive and short negative, public money left out).
The first time a line's pile reaches each size in THRS on one side, an entry is opened with DraftKings' price at that moment. When the game finishes the entry is scored two ways, and only
the totals are kept, so the record is small and lasts:
  pnl  what a contract on the pile's side made at that DraftKings price (1 or 0 minus the price, negated for the other side)
  clv  how far DraftKings' closing price moved toward the pile from that price (no luck from the result in it)
Totals are kept per size and per group (sport, market, hours before the game, how sharp the sharpest account in the pile is, whether any sharp account was against it) so the page can show
which kinds of pile, if any, beat the market.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from . import pricing

THRS = [3, 5, 10, 20, 40]
MIN_SHARP = 0.1  # an account counts toward a pile once it has this much of a record in the sport
KEEP_OPEN_DAYS = 10
RECENT = 60


def load(meta: dict) -> dict:
    v = meta.get("piles") or {}
    return {"open": v.get("open", {}), "cells": v.get("cells", {}), "recent": v.get("recent", []), "dirty": False}


def dump(s: dict) -> dict:
    return {"open": s["open"], "cells": s["cells"], "recent": s["recent"][:RECENT]}


def groups(e: dict) -> list[str]:
    """The groups one entry belongs to, for the totals."""
    hrs, top = e["hrs"], e["top"]
    return ["all", f"sport:{e['sport']}", f"kind:{e['kind']}", "hrs:<6" if hrs < 6 else "hrs:6-24" if hrs < 24 else "hrs:>24",
            "top:<0.3" if top < 0.3 else "top:0.3-0.5" if top < 0.5 else "top:>=0.5", "against:none" if e["opp"] == 0 else "against:some"]


def scan(s: dict, by_k: dict, markets: dict, now: datetime) -> None:
    """by_k[contract key] = {"v": sharp-weighted net, "long": accounts long, "short": accounts short, "top": highest sharpness}."""
    for k, d in by_k.items():
        mk = markets.get(k)
        if not mk or mk["hrs"] < 0.25 or abs(d["v"]) < THRS[0]:
            continue
        side = 1 if d["v"] > 0 else -1
        key = f"{k}|{side}"
        o = s["open"].setdefault(key, {"gid": mk["gid"], "kind": mk["kind"], "line": mk["line"], "sport": mk["sport"], "side": side, "thr": {}})
        for t in THRS:
            if abs(d["v"]) >= t and str(t) not in o["thr"]:
                o["thr"][str(t)] = {"ts": now.isoformat(), "hrs": round(mk["hrs"], 1), "ref": round(mk["ref"], 4), "v": round(abs(d["v"]), 1),
                                    "n": d["long"] if side > 0 else d["short"], "opp": d["short"] if side > 0 else d["long"], "top": round(d["top"], 2)}
                s["dirty"] = True


def resolve(s: dict, gid: str, g: dict) -> None:
    hs, as_ = g.get("home_score"), g.get("away_score")
    for key in [k for k, o in s["open"].items() if o["gid"] == gid]:
        o = s["open"].pop(key)
        s["dirty"] = True
        if hs is None or as_ is None or g.get("voided"):
            continue
        y = pricing.outcome(o["kind"], o["line"], hs, as_)
        if y == 0.5:
            continue
        row = next((r for r in (g.get("book") or []) if r[0] == o["kind"] and r[1] == o["line"]), None)
        close = row[2] if row else None
        for t, e in o["thr"].items():
            pnl = o["side"] * (y - e["ref"])
            clv = None if close is None else o["side"] * (close - e["ref"])
            for grp in groups({**e, "sport": o["sport"], "kind": o["kind"]}):
                c = s["cells"].setdefault(f"{t}|{grp}", [0, 0, 0.0, 0.0, 0.0, 0.0, 0])
                c[0] += 1
                c[1] += pnl > 0
                c[2] += pnl
                c[3] += pnl * pnl
                if clv is not None:
                    c[4] += clv
                    c[5] += clv * clv
                    c[6] += 1
            if t == str(THRS[2]):
                s["recent"].insert(0, {"game": gid, "teams": f"{g['away']['abbr']} @ {g['home']['abbr']}", "sport": o["sport"], "kind": o["kind"], "line": o["line"], "side": o["side"],
                                       "ref": e["ref"], "close": close, "y": y, "v": e["v"], "n": e["n"], "opp": e["opp"], "top": e["top"], "ts": e["ts"]})
    s["recent"] = s["recent"][:RECENT]


def prune(s: dict, now: datetime) -> None:
    cut = (now - timedelta(days=KEEP_OPEN_DAYS)).isoformat()
    for k in [k for k, o in s["open"].items() if all(e["ts"] < cut for e in o["thr"].values())]:
        del s["open"][k]
        s["dirty"] = True
