"""The nightly snapshot behind the Overnight board, and its scoring the next day.

Around 8 PM US Eastern, when DraftKings has next day's lines up, the first exchange round writes one record (ex_meta key "overnight:YYYY-MM-DD") with every main line of
the games starting in the next 36 hours: DraftKings' number and price, the exchange's price, where the accounts with a closing-line record have traded since DraftKings posted
(weighted by how sharp each is), how far the line is expected to move before the close, and for college basketball what the site's movement model says.

Later rounds score it: when a game has started the record gets the closing number, how far it moved, and the result at the number that was up at 8 PM, so the board can
show over time whether a lean, a movement-model call or a volatility rank beat the close.

Expected move is the average size of the move from two hours after DraftKings posted a line to the close, measured on the 164 games the exchange had priced first
(a week of games, so rough): by sport and market, scaled up for the lowest college basketball tier, big spreads and mid-range totals, and where the exchange's own line was far
from what DraftKings posted, and down a little for every hour since the line went up. It says how far a line is likely to travel, not which way.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import pricing

ET = ZoneInfo("America/New_York")
SNAP_HOUR = 20
HORIZON_H = 36
KEEP_DAYS = 21
SPORTS = ("cbb", "cfb", "nba", "nfl")
BASE = {("cbb", "spread"): 2.0, ("cbb", "total"): 2.6, ("cfb", "spread"): 1.1, ("cfb", "total"): 1.6, ("nba", "spread"): 0.9, ("nba", "total"): 1.9, ("nfl", "spread"): 1.0, ("nfl", "total"): 1.5}
SHARP_MIN = 0.3
LEAN_MIN = 40.0  # weighted contracts: a net lean smaller than this is not called a lean


def expected_move(sport: str, kind: str, tier: str | None, level: float | None, gap_int: float | None, hrs_since: float | None) -> float | None:
    base = BASE.get((sport, kind))
    if base is None:
        return None
    m = 1.0
    if sport == "cbb" and tier == "CC":
        m *= 1.2
    if level is not None:
        if kind == "spread" and abs(level) >= 15:
            m *= 1.2
        if kind == "total":
            m *= 1.2 if 140 <= level < 155 else 0.8 if level < 140 else 1.0
    if gap_int is not None:
        g = abs(gap_int)
        m *= (1.3 if kind == "spread" else 1.5) if g >= 6 else (0.7 if kind == "spread" else 1.0) if g < 2 else 1.0
    m *= max(0.65, 1.0 - 0.025 * (hrs_since if hrs_since is not None else 8.0))
    return round(base * m, 2)


def _p(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _site_id(gid: str) -> int | None:
    sport, _, eid = gid.partition(":")
    return -(7_000_000_000 + int(eid)) if sport == "cbb" and eid.isdigit() else None


def snapshot(store, now: datetime, day: str, meta: dict) -> dict | None:
    games = [g for g in store.rows("ex_games", {"completed": False}) if g["sport"] in SPORTS and g["state"] == "pre" and (g.get("ref") or {}).get("src", "dk") == "dk" and g.get("views")
             and now < _p(g["start_utc"]) < now + timedelta(hours=HORIZON_H)]
    if not games:
        return None
    ids = [g["id"] for g in games]
    disc = {d["id"]: d for d in ((meta.get("discovery") or {}).get("rows") or [])}
    members = {m["id"]: m for m in store.rows("ex_members")}
    syn = {s["id"]: s["name"] for s in store.rows("ex_syndicates")}
    since = (now - timedelta(hours=48)).isoformat()
    trades: dict[str, list[dict]] = {}
    for i in range(0, len(ids), 25):
        start = 0
        while True:
            page = store.c.table("ex_trades").select("ts,game_id,kind,qty,buyer,seller,maker").in_("game_id", ids[i : i + 25]).gte("ts", since).order("ts").range(start, start + 999).execute().data
            for t in page:
                trades.setdefault(t["game_id"], []).append(t)
            if len(page) < 1000:
                break
            start += 1000
    board = {}
    sids = [s for s in (_site_id(g) for g in ids) if s is not None]
    for i in range(0, len(sids), 100):
        for r in store.c.table("cbb_game_board").select("game_id,updated_at,payload").in_("game_id", sids[i : i + 100]).execute().data:
            board[r["game_id"]] = r
    rows = []
    for g in games:
        v = g["views"]
        d = disc.get(g["id"])
        found = _p(d["found"]) if d else None
        hrs_since = None if found is None else (now - found).total_seconds() / 3600
        bd = board.get(_site_id(g["id"]) or 0)
        bage = None if not bd else (now - _p(bd["updated_at"])).total_seconds() / 3600
        for i, (kind, line) in enumerate(v.get("lines") or []):
            if kind not in ("spread", "total", "ml"):
                continue
            p, x = v["r"][i], (v.get("x") or [None] * 9)[i]
            net, sq, tq, who = 0.0, 0.0, 0.0, {}
            for t in trades.get(g["id"], []):
                if t["kind"] != kind or (found is not None and _p(t["ts"]) < found):
                    continue
                tq += t["qty"]
                tk = t["buyer"] if t["maker"] == t["seller"] else t["seller"]
                m = members.get(tk)
                if not m or m["params"].get("public") or m["params"].get("lab"):
                    continue
                s = float((m["stats"].get("sharp") or {}).get(g["sport"], 0.0))
                if s < SHARP_MIN:
                    continue
                dr = 1 if tk == t["buyer"] else -1
                sq += t["qty"]
                net += dr * t["qty"] * s
                w = who.setdefault(tk, {"name": m["name"], "firm": syn.get(m["syndicate_id"], m["syndicate_id"]), "w": 0.0})
                w["w"] += dr * t["qty"] * s
            gap_int = None
            if d and kind != "ml":
                ix = 0 if kind == "spread" else 1
                a, b = d["int_line"][ix], d["dk_line"][ix]
                gap_int = None if a is None or b is None else a - b
            row = {"game": g["id"], "sport": g["sport"], "teams": f"{g['away']['abbr']} @ {g['home']['abbr']}", "home_id": g["home"]["id"], "start": g["start_utc"], "kind": kind,
                   "line": line, "p": round(p, 4), "x": None if x is None else round(x, 4), "flow": round(net, 1), "sharp_q": round(sq, 1), "traded_q": round(tq, 1),
                   "who": [{**w, "w": round(w["w"], 1)} for w in sorted(who.values(), key=lambda z: -abs(z["w"]))[:3]], "posted_h": None if hrs_since is None else round(hrs_since, 1),
                   "exp_move": None if kind == "ml" else expected_move(g["sport"], kind, v.get("tier"), line, gap_int, hrs_since)}
            if bd and kind in ("spread", "total") and bage is not None and bage <= 12:  # the site's movement model: which way and how far it expects the number to go; ignored when the board is stale
                bet = (bd["payload"].get("bets") or {}).get(kind) or {}
                row["mm"] = {"side": bet.get("side"), "clv": bet.get("clv"), "age_h": round(bage, 1)}
            rows.append(row)
    rec = {"ts": now.isoformat(), "date": day, "rows": rows, "scored": False}
    store.upsert("ex_meta", [{"key": f"overnight:{day}", "value": rec}])
    return rec


def score(store, now: datetime, key: str, rec: dict) -> bool:
    """Fills in the close and the result for every row whose game has finished. True when the record changed."""
    pend = [r for r in rec["rows"] if not r.get("done")]
    if not pend:
        rec["scored"] = True
        return True
    ids = sorted({r["game"] for r in pend})
    gm = {}
    for i in range(0, len(ids), 40):
        for g in store.c.table("ex_games").select("id,completed,voided,home,home_score,away_score,views").in_("id", ids[i : i + 40]).execute().data:
            gm[g["id"]] = g
    changed = False
    for r in pend:
        g = gm.get(r["game"])
        if not g or not g["completed"] or g.get("home_score") is None:
            continue
        r["done"] = True
        changed = True
        if g.get("voided") or str(g["home"]["id"]) != str(r["home_id"]):
            r["void"] = True  # ESPN swapped home and away (or the game was voided): the numbers do not line up with the result
            continue
        v = g.get("views") or {}
        close = next(((ln, v["r"][i]) for i, (k, ln) in enumerate(v.get("lines") or []) if k == r["kind"]), None)
        if close is None:
            continue
        r["close_line"], r["close_p"] = close
        if r["kind"] == "spread":
            r["move"] = round((-close[0]) - (-r["line"]), 2)      # points toward the home side
        elif r["kind"] == "total":
            r["move"] = round(close[0] - r["line"], 2)             # points up
        else:
            r["move"] = round(close[1] - r["p"], 4)                # home fair price, as a share
        r["y"] = pricing.outcome(r["kind"], r["line"], g["home_score"], g["away_score"])
    if all(r.get("done") for r in rec["rows"]):
        rec["scored"] = True
        changed = True
    return changed


def run(store, now: datetime) -> dict:
    meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    et = now.astimezone(ET)
    day = et.strftime("%Y-%m-%d")
    out = {"snapshot": False, "scored": 0}
    if et.hour >= SNAP_HOUR and f"overnight:{day}" not in meta:
        out["snapshot"] = snapshot(store, now, day, meta) is not None
        meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    cut = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for key, rec in sorted(meta.items()):
        if not key.startswith("overnight:"):
            continue
        if key[10:] < cut:
            store.c.table("ex_meta").delete().eq("key", key).execute()
            continue
        if rec.get("scored"):
            continue
        if score(store, now, key, rec):
            store.upsert("ex_meta", [{"key": key, "value": rec}])
            out["scored"] += 1
    return out
