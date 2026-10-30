"""A paper log of the exchange disagreeing with DraftKings, scored later. Nothing here is a betting signal; it exists to find out whether any kind of disagreement carries information.

Two kinds are watched on a game's three main lines, while DraftKings is the baseline:
  gap    the exchange's two-sided price is at least GAP away from DraftKings' price (whoever moved it: makers, public money, anyone)
  sharp  the flow of traders with a closing-line record has moved the game's price at least SHARP the same way (only exists once someone has earned a reputation)
The first time a line shows either, one entry is opened with the prices at that moment. When the game finishes it is scored three ways: did DraftKings' close move toward it,
what a contract bought (or sold) at DraftKings' price at that moment made, and what it made at the exchange's own price.
"""
from __future__ import annotations

from datetime import datetime, timedelta

GAP = 0.02
SHARP = 0.01
KEEP_OPEN_DAYS = 10
KEEP_DONE = 4000


def load(meta: dict) -> dict:
    v = meta.get("signals") or {}
    return {"open": v.get("open", {}), "done": v.get("done", []), "dirty": False}


def dump(s: dict) -> dict:
    return {"open": s["open"], "done": s["done"][:KEEP_DONE]}


def scan(s: dict, g: dict, views: dict, two_sided: dict, delta: dict, markets: dict, ckey, now: datetime, start: datetime) -> None:
    hrs = (start - now).total_seconds() / 3600
    if hrs < 0.25:
        return
    for kind, line in views["lines"]:
        k = ckey(g["id"], kind, line)
        mk = markets.get(k)
        if not mk:
            continue
        r, x, d = mk["ref"], two_sided.get(k), delta.get(k, 0.0)
        for typ, val, hit in (("gap", None if x is None else x - r, x is not None and abs(x - r) >= GAP), ("sharp", d, abs(d) >= SHARP)):
            sid = f"{g['id']}|{kind}|{line}|{typ}"
            if not hit or sid in s["open"]:
                continue
            s["open"][sid] = {"id": sid, "game": g["id"], "sport": g["sport"], "teams": f"{g['away']['abbr']} @ {g['home']['abbr']}", "kind": kind, "line": line, "type": typ,
                              "side": 1 if val > 0 else -1, "ts": now.isoformat(), "hrs": round(hrs, 1), "ref": round(r, 4), "x": None if x is None else round(x, 4),
                              "size": round(abs(val), 4)}
            s["dirty"] = True


def resolve(s: dict, gid: str, closing: dict | None) -> None:
    mine = [v for v in s["open"].values() if v["game"] == gid]
    for v in mine:
        del s["open"][v["id"]]
        s["dirty"] = True
        if not closing or (closing.get("src") or "dk") != "dk":
            continue
        idx = next((i for i, (kd, ln) in enumerate(closing["lines"]) if kd == v["kind"] and ln == v["line"]), None)
        if idx is None or closing["y"][idx] == 0.5:
            continue  # the main line moved to a different number: not comparable
        y, dk, side = closing["y"][idx], closing["dk"][idx], v["side"]
        s["done"].insert(0, {**v, "dk_close": dk, "y": y, "moved": round(side * (dk - v["ref"]), 4), "pnl_dk": round(side * (y - v["ref"]), 4),
                             "pnl_x": None if v["x"] is None else round(side * (y - v["x"]), 4)})


def prune(s: dict, now: datetime) -> None:
    cut = (now - timedelta(days=KEEP_OPEN_DAYS)).isoformat()
    for sid in [k for k, v in s["open"].items() if v["ts"] < cut]:
        del s["open"][sid]
        s["dirty"] = True
