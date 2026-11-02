"""Paper picks: what the models would play, logged at the price they were first playable and graded afterwards. Nothing is bet.

Each generator names its picks (`source`), so the scorecard shows which kind of pick actually works. The first generator is the CBB movement
model (python/cbb_model): it predicts how far each line will move before the close, and a pick is the side the line should move toward, taken
at the number that is up now. It is graded two ways: closing-line value in points against the closing number, and the result at the number taken.

Staking is tracked both ways, at no extra cost: flat (1 unit on every pick, the number to judge the model by, since it is the cleanest statistic)
and scaled (units grow with the expected value, 0.5 to 2, to see whether the model knows which picks are better). Prices are taken as -110 unless the
board has one: the Desk only stores the home side's spread price.

State lives in ex_meta key "picks": {"open": {id: pick}, "done": {id: pick}}. A pick is logged once per game and market and never changed.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

PRICE = -110.0
WIN_UNITS = 100.0 / 110.0  # profit on a winning 1-unit bet at -110
# tiers from the walk-forward test of the movement model (python -m cbb_model.movement): the size of the predicted remaining move, in points, AND the
# game's rank on the board. The test tiers were shares of a season's games (A the top ~7% and B the top ~20% of spreads: CLV about +1.5 to +2.0 and +0.9 to +1.1),
# so a pick must also sit inside that share of the games priced right now. Early in the season many opens are stale and half the board looks "playable", which this keeps in check.
SPREAD_TIERS = ((1.0, "A"), (0.5, "B"))  # minimum predicted move for each tier
TOTAL_TIERS = ((1.3, "A"), (1.0, "B"))
SHARE_A, SHARE_B = 0.07, 0.20  # share of the priced games that can be tier A, and tier A or B together
MIN_LEAD = timedelta(minutes=60)  # no picks inside the last hour before the start: the number is about to be the close
MOVED = 0.5  # points: a line that has already moved this far from its open is "moved"; a pick may not bet that it will move back
KEEP_DAYS = 90
BOARD_MAX_AGE = timedelta(hours=3)  # the board is rewritten every 30 to 60 minutes while its job runs: a board older than this is stale and makes no picks


def _tier(x: float, tiers) -> str | None:
    for thr, name in tiers:
        if x >= thr:
            return name
    return None


def scaled_units(rem: float, kind: str) -> float:
    """Units for the scaled track: 1 unit at the A threshold, down to 0.5 and up to 2 in proportion to the predicted move."""
    ref = 1.0 if kind == "spread" else 1.3
    return round(min(2.0, max(0.5, abs(rem) / ref)), 2)


def _load(store) -> dict:
    v = next((r["value"] for r in store.rows("ex_meta") if r["key"] == "picks"), None) or {}
    return {"open": v.get("open", {}), "done": v.get("done", {})}


def generate_cbb(client, now: datetime, have: set) -> list[dict]:
    """New CBB movement picks from the published board: one per game and market, the first time the predicted remaining move clears a tier."""
    snap = client.table("cbb_odds_snapshots").select("captured_at").order("captured_at", desc=True).limit(1).execute().data or []
    if not snap or now - datetime.fromisoformat(snap[0]["captured_at"].replace("Z", "+00:00")) > BOARD_MAX_AGE:
        return []  # the lines themselves are stale (the odds timer or the Update scores & lines button has not run): no picks off old numbers
    rows = client.table("cbb_game_board").select("game_id,start_date,home_team,away_team,payload,updated_at").gte("start_date", (now + MIN_LEAD).isoformat()).gte("updated_at", (now - BOARD_MAX_AGE).isoformat()).execute().data or []
    out = []
    # the eligible games per market: a pick follows the move the model expects from the open, and never bets that a line which has already moved will drift back
    # toward where it opened. Tiers are then a share of the eligible games, biggest predicted move first.
    elig: dict[str, list] = {"spread": [], "total": []}
    for r in rows:
        p = r["payload"] or {}
        mk, mv, bets = p.get("market") or {}, p.get("move") or {}, p.get("bets") or {}
        for kind in ("spread", "total"):
            side = (bets.get(kind) or {}).get("side")
            rem = mv.get("remaining_spread" if kind == "spread" else "remaining_total")
            line = mk.get("cur_margin" if kind == "spread" else "cur_total")
            pred = mv.get("spread" if kind == "spread" else "total")
            opened = mk.get("open_margin" if kind == "spread" else "open_total")
            if not side or rem is None or line is None or pred is None or pred * rem <= 0:
                continue
            if opened is not None and (float(line) - float(opened)) * rem < 0 and abs(float(line) - float(opened)) >= MOVED:
                continue
            elig[kind].append((abs(float(rem)), r, side, float(rem), float(line), opened, mk))
    for kind in ("spread", "total"):
        ranked = sorted(elig[kind], key=lambda x: -x[0])
        n = len(ranked)
        for i, (size, r, side, rem, line, opened, mk) in enumerate(ranked):
            pid = f"cbb:{r['game_id']}|{kind}"
            tier = _tier(size, SPREAD_TIERS if kind == "spread" else TOTAL_TIERS)
            if tier == "A" and i >= math.ceil(SHARE_A * n):
                tier = "B"  # big enough for A but not among the biggest few eligible games on the board
            if tier == "B" and i >= math.ceil(SHARE_B * n):
                tier = None
            if pid in have or not tier:
                continue
            out.append({
                "id": pid, "source": "cbb_movement", "sport": "cbb", "game_id": r["game_id"], "kind": kind, "side": side, "line": line,
                "price": PRICE, "tier": tier, "rem": round(rem, 2), "exp_clv": round(size, 2), "units": 1.0, "units_scaled": scaled_units(rem, kind),
                "ts": now.isoformat(), "start": r["start_date"], "teams": f"{r['away_team']} @ {r['home_team']}", "home": r["home_team"], "away": r["away_team"],
                "open": opened,
            })
    return out


def grade_cbb(client, picks: dict, now: datetime) -> list[dict]:
    """Picks whose game has finished: the closing number (ESPN's, saved when the game went final), the score, CLV in points and the result at the number taken."""
    ids = sorted({int(p["game_id"]) for p in picks.values() if p["source"] == "cbb_movement" and datetime.fromisoformat(p["start"]) < now - timedelta(hours=1)})
    done = []
    for i in range(0, len(ids), 150):
        part = ids[i : i + 150]
        g = {r["id"]: r for r in client.table("games").select("id,completed,home_points,away_points").in_("id", part).execute().data or []}
        c = {r["game_id"]: r for r in client.table("cbb_game_opens").select("game_id,spread_home_close,total_close").in_("game_id", part).execute().data or []}
        for p in picks.values():
            gid = p["game_id"]
            if p["source"] != "cbb_movement" or gid not in part:
                continue
            row, close = g.get(gid), c.get(gid)
            if not row or not row.get("completed") or row.get("home_points") is None or row.get("away_points") is None or not close:
                continue
            margin, total = float(row["home_points"]) - float(row["away_points"]), float(row["home_points"]) + float(row["away_points"])
            if p["kind"] == "spread":
                if close.get("spread_home_close") is None:
                    continue
                cl = -float(close["spread_home_close"])  # the home margin the closing spread implies
                clv = (cl - p["line"]) if p["side"] == "home" else (p["line"] - cl)
                d = margin - p["line"]
                res = 0.0 if d == 0 else (1.0 if (d > 0) == (p["side"] == "home") else -1.0)
            else:
                if close.get("total_close") is None:
                    continue
                cl = float(close["total_close"])
                clv = (cl - p["line"]) if p["side"] == "over" else (p["line"] - cl)
                d = total - p["line"]
                res = 0.0 if d == 0 else (1.0 if (d > 0) == (p["side"] == "over") else -1.0)
            pnl = WIN_UNITS if res > 0 else -1.0 if res < 0 else 0.0
            done.append({**p, "close": round(cl, 2), "clv": round(clv, 2), "result": res, "pnl": round(pnl, 3), "pnl_scaled": round(pnl * p["units_scaled"], 3),
                         "actual": round(margin if p["kind"] == "spread" else total, 1), "graded": now.isoformat()})
    return done


def run(store, now: datetime | None = None) -> dict:
    """One pass: log new picks, grade the finished ones, tidy old ones. Safe to call every round; any failure is the caller's to swallow."""
    now = now or datetime.now(timezone.utc)
    st = _load(store)
    client = store.c
    new = generate_cbb(client, now, set(st["open"]) | set(st["done"]))
    for p in new:
        st["open"][p["id"]] = p
    graded = grade_cbb(client, st["open"], now)
    for p in graded:
        st["done"][p["id"]] = p
        st["open"].pop(p["id"], None)
    cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat()
    st["done"] = {k: v for k, v in st["done"].items() if v.get("graded", "") >= cutoff}
    if new or graded:
        store.upsert("ex_meta", [{"key": "picks", "value": st}])
    return {"new": len(new), "graded": len(graded), "open": len(st["open"]), "done": len(st["done"])}
