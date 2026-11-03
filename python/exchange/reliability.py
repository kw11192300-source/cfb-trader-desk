"""Reliability (calibration) record: when a price said p, how often did it happen?

Every settled trade is one observation. For the exchange as a whole the observation is the price traded (the probability of "yes") against the outcome; for a
syndicate or a trader it is their own side - what they paid for the side they took against whether that side won. Observations are put into ten price bins and
kept per entity, sport and market, and they are added once per game when it settles, so the record is cumulative and survives the trades being tidied away.

Layout of the stored value (ex_meta key "rel"):
  games: ids already counted (so a backfill and the live round never double count)
  cells: {entity: {"sport|kind": {bin: [trades, contracts, sum of price x contracts, sum of outcome x contracts]}}}
  entity is "x" (the exchange), "s:<syndicate id>" or "m:<trader id>"
"""
from __future__ import annotations

BINS = 10
ALT_ENTITIES = ("x", "s:wing")  # the alternate-line record is kept for the exchange as a whole and for the Wing Desk's own side


def _bin(p: float) -> str:
    return str(min(BINS - 1, max(0, int(p * BINS))))


def _add(cells: dict, entity: str, sport: str, kind: str, p: float, y: float, q: float) -> None:
    c = cells.setdefault(entity, {}).setdefault(f"{sport}|{kind}", {}).setdefault(_bin(p), [0, 0.0, 0.0, 0.0])
    c[0] += 1
    c[1] += q
    c[2] += q * p
    c[3] += q * y


def add_game(rel: dict, gid: str, sport: str, trades: list[dict], members: dict) -> bool:
    """Counts one finished game's settled trades; False if the game was already counted."""
    if gid in rel["_seen"]:
        return False
    rel["_seen"].add(gid)
    cells = rel["cells"]
    for t in trades:
        out = t.get("outcome")
        if out is None or out == 0.5:
            continue
        p, q, kind = t["price"], t["qty"], t["kind"]
        _add(cells, "x", sport, kind, p, out, q)
        for who, pp, yy in ((t["buyer"], p, out), (t["seller"], 1 - p, 1 - out)):
            m = members.get(who)
            if not m:
                continue
            _add(cells, f"s:{m['syndicate_id']}", sport, kind, pp, yy, q)
            _add(cells, f"m:{who}", sport, kind, pp, yy, q)
    return True


def off_bucket(off: float) -> str:
    """How far a line sits from the main number, in points: the buckets the alternate-line record is kept in."""
    return "main" if off <= 0.5 else "1" if off <= 1.5 else "2" if off <= 2.5 else "3-4" if off <= 4.5 else "5+"


def add_alt(rel: dict, gid: str, sport: str, trades: list[dict], members: dict, main: dict) -> bool:
    """The same observations, kept by distance from the main number: is a price on a line two, three, six points off the main one as right as on the main line?
    Layout: rel["alt"][entity]["sport|kind"][bucket] = [trades, contracts, sum of price x contracts, sum of outcome x contracts]; a game is counted once."""
    if gid in rel["alt_seen"]:
        return False
    rel["alt_seen"].add(gid)
    for t in trades:
        out, kind = t.get("outcome"), t["kind"]
        mn = main.get(kind)
        if out is None or out == 0.5 or kind not in ("spread", "total") or mn is None:
            continue
        b = off_bucket(abs(t["line"] - mn))
        p, q = t["price"], t["qty"]
        _add_alt(rel["alt"], "x", sport, kind, b, p, out, q)
        for who, pp, yy in ((t["buyer"], p, out), (t["seller"], 1 - p, 1 - out)):
            m = members.get(who)
            if m and m["syndicate_id"] == "wing":
                _add_alt(rel["alt"], "s:wing", sport, kind, b, pp, yy, q)
    return True


def _add_alt(alt: dict, entity: str, sport: str, kind: str, bucket: str, p: float, y: float, q: float) -> None:
    c = alt.setdefault(entity, {}).setdefault(f"{sport}|{kind}", {}).setdefault(bucket, [0, 0.0, 0.0, 0.0])
    c[0] += 1
    c[1] += q
    c[2] += q * p
    c[3] += q * y


def load(meta: dict) -> dict:
    v = meta.get("rel") or {}
    return {"_seen": set(v.get("games", [])), "cells": v.get("cells", {}), "alt_seen": set(v.get("alt_games", [])), "alt": v.get("alt", {})}


def dump(rel: dict) -> dict:
    rnd = lambda c: {e: {sk: {b: [v[0], round(v[1], 2), round(v[2], 3), round(v[3], 3)] for b, v in bins.items()} for sk, bins in sks.items()} for e, sks in c.items()}  # noqa: E731
    alt = {e: {sk: {b: [v[0], round(v[1], 2), round(v[2], 3), round(v[3], 3)] for b, v in bins.items()} for sk, bins in sks.items()} for e, sks in rel["alt"].items()}
    return {"games": sorted(rel["_seen"]), "cells": rnd(rel["cells"]), "alt_games": sorted(rel["alt_seen"]), "alt": alt}


def backfill(store) -> int:
    """Rebuilds the record from every settled trade still in the database (games already counted are skipped)."""
    members = {m["id"]: m for m in store.rows("ex_members")}
    rel = load({r["key"]: r["value"] for r in store.rows("ex_meta")})
    by_game: dict[str, list[dict]] = {}
    for t in store.rows("ex_trades", {"settled": True}):
        by_game.setdefault(t["game_id"], []).append(t)
    n = 0
    for gid, trs in by_game.items():
        if any(t.get("outcome") is None for t in trs):
            continue
        n += add_game(rel, gid, gid.split(":")[0], trs, members)
    games = {g["id"]: g for g in store.rows("ex_games")}
    for gid, trs in by_game.items():  # the by-distance record, from each game's closing main lines
        g = games.get(gid)
        if g and g.get("ref") and not g.get("voided") and not any(t.get("outcome") is None for t in trs):
            add_alt(rel, gid, gid.split(":")[0], trs, members, {"spread": g["ref"].get("spread"), "total": g["ref"].get("total")})
    store.upsert("ex_meta", [{"key": "rel", "value": dump(rel)}])
    return n
