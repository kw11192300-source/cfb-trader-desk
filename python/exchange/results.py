"""Historicals: what each finished game did to every syndicate and trader, the daily digest, and housekeeping.

A game's result is computed from its whole trade ledger when it settles, so netted trades count in full: for any trader the profit on a contract is the sum over
its trades of qty x (outcome - price) when it bought and qty x (price - outcome) when it sold. The result row is small and kept forever; the trades behind it are
deleted after a couple of weeks so the live tables stay light.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from . import pricing

try:
    from zoneinfo import ZoneInfo

    ET = ZoneInfo("America/New_York")
except Exception:  # no tz database on this machine: fixed Eastern standard time
    ET = timezone(timedelta(hours=-5))


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def et_day(iso: str) -> str:
    return _dt(iso).astimezone(ET).date().isoformat()


def game_result(g: dict, trades: list[dict], members: dict) -> dict:
    """Result row for one finished game from every trade ever made on it."""
    syn: dict[str, dict] = {}
    trd: dict[str, dict] = {}
    top = []
    contracts = traded = 0.0

    def add(table: dict, key: str, pnl: float, cost: float, clv: float | None) -> None:
        r = table.setdefault(key, {"pnl": 0.0, "traded": 0.0, "n": 0, "clv_sum": 0.0, "clv_n": 0})
        r["pnl"] += pnl
        r["traded"] += cost
        r["n"] += 1
        if clv is not None:
            r["clv_sum"] += clv
            r["clv_n"] += 1

    for t in trades:
        out, q, px, cp = t["outcome"], t["qty"], t["price"], t.get("close_p")
        contracts += q
        sides = ((t["buyer"], q * (out - px) if out != 0.5 else 0.0, q * px, None if cp is None else cp - px),
                 (t["seller"], q * (px - out) if out != 0.5 else 0.0, q * (1 - px), None if cp is None else px - cp))
        traded += q * px + q * (1 - px)
        for who, pnl, cost, clv in sides:
            sid = members[who]["syndicate_id"]
            add(syn, sid, pnl, cost, clv)
            add(trd, who, pnl, cost, clv)
        taker_is_buyer = t["maker"] == t["seller"]
        if cp is not None:
            tclv = (cp - px) if taker_is_buyer else (px - cp)
            top.append({"taker": t["buyer"] if taker_is_buyer else t["seller"], "kind": t["kind"], "line": t["line"], "price": px, "qty": q, "clv": round(tclv, 4), "side": "buy" if taker_is_buyer else "sell", "close": round(cp, 4), "score": q * tclv})
    top.sort(key=lambda x: -x["score"])
    # the closing prices of the game's three main lines from every source, with how each came out, for judging the exchange against DraftKings
    closing = None
    v = g.get("views") or {}
    if v.get("lines") and v.get("r") and g.get("home_score") is not None:
        ks = {(k, ln): mid for k, ln, mid, *_ in (v.get("kal") or [])}
        lines = [tuple(x) for x in v["lines"]]
        sharp_net = []
        for kind, line in lines:
            net = 0.0
            for t in trades:
                if t["kind"] != kind or t["line"] != line:
                    continue
                taker = t["buyer"] if t["maker"] == t["seller"] else t["seller"]
                if (members[taker]["stats"].get("sharp") or {}).get(g["sport"], 0) >= 0.3:
                    net += t["qty"] if taker == t["buyer"] else -t["qty"]
            sharp_net.append(round(net, 1))
        closing = {"src": v.get("src", "dk"), "lines": [list(x) for x in lines], "dk": v["r"], "x": v.get("x"), "ks": [ks.get(x) for x in lines], "e": v.get("e"),
                   "y": [pricing.outcome(k, ln, g["home_score"], g["away_score"]) for k, ln in lines], "sharp": sharp_net}
    rnd = lambda d: {k: {kk: round(vv, 3) for kk, vv in v.items()} for k, v in d.items()}  # noqa: E731
    return {"id": g["id"], "day": et_day(g["start_utc"]), "sport": g["sport"], "kickoff": g["start_utc"], "home": g["home"], "away": g["away"],
            "home_score": g.get("home_score"), "away_score": g.get("away_score"), "n_trades": len(trades), "contracts": round(contracts, 1),
            "traded": round(traded, 1), "syn": rnd(syn), "traders": rnd(trd), "top": [{k: v for k, v in x.items() if k != "score"} for x in top[:3]], "closing": closing,
            "settled_at": datetime.now(timezone.utc).isoformat()}


def backfill_closing(store) -> int:
    """Fills in the closing prices of results written before that column existed, from the stored game and its trade ledger. Touches nothing else."""
    members = {m["id"]: m for m in store.rows("ex_members")}
    n = 0
    for r in store.rows("ex_results"):
        if r.get("closing") and all("close" in x for x in (r.get("top") or [])):
            continue
        gs = store.rows("ex_games", {"id": r["id"]})
        if not gs or not gs[0].get("views"):
            continue
        g = gs[0]
        row = game_result(g, store.rows("ex_trades", {"game_id": r["id"]}), members)
        if not row["closing"]:
            continue
        row["settled_at"] = r.get("settled_at") or row["settled_at"]
        store.upsert("ex_results", [row])
        n += 1
    return n


def make_digest(day: str, results: list[dict], syns: dict, members: dict) -> dict:
    """The morning summary of one US-Eastern day's finished games."""
    by_syn: dict[str, dict] = {}
    by_trader: dict[str, dict] = {}
    for r in results:
        for sid, v in r["syn"].items():
            a = by_syn.setdefault(sid, {"pnl": 0.0, "traded": 0.0, "n": 0, "clv_sum": 0.0, "clv_n": 0})
            for k in a:
                a[k] += v[k]
        for mid, v in r["traders"].items():
            a = by_trader.setdefault(mid, {"pnl": 0.0, "traded": 0.0})
            a["pnl"] += v["pnl"]
            a["traded"] += v["traded"]
    srows = [{"id": sid, "name": syns[sid]["name"], "pnl": round(v["pnl"], 1), "traded": round(v["traded"]), "trades": v["n"],
              "clv": round(v["clv_sum"] / v["clv_n"], 4) if v["clv_n"] else None, "clv_n": v["clv_n"]} for sid, v in by_syn.items() if sid in syns]
    trows = [{"id": mid, "name": members[mid]["name"], "syn": syns[members[mid]["syndicate_id"]]["name"], "pnl": round(v["pnl"], 1)} for mid, v in by_trader.items() if mid in members]
    trows.sort(key=lambda x: -x["pnl"])
    sharp = sorted([dict(x, game=r["id"], teams=f"{r['away']['abbr']} @ {r['home']['abbr']}") for r in results for x in r.get("top", [])], key=lambda x: -x["qty"] * x["clv"])[:5]
    for x in sharp:
        m = members.get(x["taker"])
        x["who"] = f"{m['name']} ({syns[m['syndicate_id']]['name']})" if m else x["taker"]
    games = sorted(({"id": r["id"], "teams": f"{r['away']['abbr']} @ {r['home']['abbr']}", "sport": r["sport"], "score": f"{r['away_score']}-{r['home_score']}", "contracts": r["contracts"],
                     "winner": max(r["syn"].items(), key=lambda kv: kv[1]["pnl"])[0] if r["syn"] else None,
                     "win_pnl": round(max((v["pnl"] for v in r["syn"].values()), default=0.0), 1)} for r in results), key=lambda x: -x["contracts"])[:6]
    for x in games:
        x["winner"] = syns[x["winner"]]["name"] if x["winner"] in syns else None
    labs = []
    for sid, s in syns.items():
        a = ((s.get("learn") or {}).get("agent") or {})
        if a.get("published_at") and et_day(a["published_at"]) == day:
            labs.append({"id": sid, "name": s["name"], "version": a.get("version"), "notes": a.get("notes")})
    return {"day": day, "games": len(results), "contracts": round(sum(r["contracts"] for r in results)), "traded": round(sum(r["traded"] for r in results)),
            "syndicates": sorted(srows, key=lambda x: -x["pnl"]), "best_traders": trows[:5], "worst_traders": trows[::-1][:5], "sharp": sharp, "games_top": games, "labs": labs,
            "weights": sorted(({"name": s["name"], "sport": sp, "w": w} for sid, s in syns.items() for sp, w in ((s.get("learn") or {}).get("w") or {}).items()), key=lambda x: -x["w"])[:5]}


def maybe_digest(store, meta: dict, syns: dict, members: dict, now: datetime) -> str | None:
    """After 6 am Eastern, write yesterday's digest once."""
    et = now.astimezone(ET)
    if et.hour < 6:
        return None
    day = (et.date() - timedelta(days=1)).isoformat()
    if f"digest:{day}" in meta:
        return None
    results = store.rows("ex_results", {"day": day})
    store.upsert("ex_meta", [{"key": f"digest:{day}", "value": make_digest(day, results, syns, members)}])
    return day


def prune(store, days: int = 120, snapshot_days: int = 60, marks_days: int = 21) -> dict:
    """Housekeeping: drop the trades and game rows of games settled more than `days` ago, their price history after `marks_days` (the result rows stay forever),
    and old snapshots. A trade is a few hundred bytes, so months of them are cheap to keep and the history pages read them a page at a time."""
    today = datetime.now(ET).date()
    n = 0
    old = store.old_ids("ex_results", "day", (today - timedelta(days=days)).isoformat())
    if old:
        for table, col in (("ex_trades", "game_id"), ("ex_games", "id")):
            n += store.delete_in(table, col, old)
    ids = store.old_ids("ex_results", "day", (today - timedelta(days=marks_days)).isoformat())
    if ids:
        n += store.delete_in("ex_marks", "game_id", ids)
    store.delete_before("ex_snapshots", "ts", (datetime.now(timezone.utc) - timedelta(days=snapshot_days)).isoformat())
    return {"games": len(old), "rows": n}
