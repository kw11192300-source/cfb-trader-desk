"""One round of the exchange: ingest ESPN, settle finished games, let makers quote, let takers hit, mark everyone to market.

Contracts are binary and pay 1 unit: 'yes' is home moneyline / home covers at the home line / over the total. The buyer posts the price,
the seller posts 1 - price as collateral, so nobody can lose more than they put up. A push refunds both. Trades happen at the maker's
price. Quotes only live for the round that posted them.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import numpy as np

from . import espn, pricing, ratings
from .members import roster
from .pricing import Dist, ckey, clip

HORIZON_H = 72
CUTOFF_MIN = 3
SNAP_EVERY = 3  # rounds between equity snapshots
VOID_AFTER_DAYS = 6
MAX_DEPLOY = 0.5  # share of a bankroll that may be tied up in open trades


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat()


def _pdate(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def init(store) -> None:
    syns, mems = roster()
    store.upsert("ex_syndicates", syns, ignore_existing=True)
    store.upsert("ex_members", mems, ignore_existing=True)
    store.save()


def fit_ratings(store, sports: list[str], days: int = 420) -> None:
    for sp in sports:
        games = espn.history(sp, days)
        fits = ratings.fit_all(sp, games)
        rows = [{"key": f"{sp}|{eng}", "payload": pl, "fitted_at": _iso(_now())} for eng, pl in fits.items() if pl]
        store.upsert("ex_ratings", rows)
        print(f"  {sp}: {len(games)} finished games -> {', '.join(r['key'] for r in rows)}", flush=True)
    store.save()


# ---------------------------------------------------------------- engines
def engine_dist(engine: str, g: dict, refd: Dist, refo: Dist | None, rat: dict) -> Dist | None:
    sp = g["sport"]
    hid, aid, neu = g["home"]["id"], g["away"]["id"], bool(g["neutral"])

    def pr(name):
        return ratings.predict(name, rat.get(f"{sp}|{name}"), hid, aid, neu)

    if engine in ("elo", "ridge_long", "ridge_short"):
        r = pr(engine)
        return Dist(sp, r[0], r[1]) if r else None
    if engine == "blend":
        rs = [r for r in (pr("elo"), pr("ridge_long"), pr("ridge_short")) if r]
        if len(rs) < 2:
            return None
        return Dist(sp, float(np.mean([r[0] for r in rs])), float(np.mean([r[1] for r in rs])))
    if engine in ("tape", "fade"):
        if refo is None:
            return None
        beta = 1.0 if engine == "tape" else -1.0
        return Dist(sp, refd.m + beta * (refd.m - refo.m), refd.t + beta * (refd.t - refo.t))
    if engine == "pace":
        rs = [r for r in (pr("elo"), pr("ridge_long")) if r]
        if not rs:
            return None
        return Dist(sp, refd.m, float(np.mean([r[1] for r in rs])))
    if engine == "ref":
        return refd
    return None


def p_engine(dist: Dist, refd: Dist, ml_ref: float | None, kind: str, line: float) -> float:
    if kind == "ml":
        return clip((ml_ref if ml_ref is not None else refd.p_ml()) + dist.p_ml() - refd.p_ml())
    return dist.p(kind, line)


# ---------------------------------------------------------------- round
def run_round(store, sports: list[str], seed: int | None = None, verbose: bool = True) -> dict:
    now = _now()
    meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    rnd = int((meta.get("round") or {}).get("n", 0)) + 1
    rng = random.Random(seed if seed is not None else rnd)
    if not store.rows("ex_members"):
        init(store)
    members = {m["id"]: m for m in store.rows("ex_members")}
    syns = {s["id"]: s for s in store.rows("ex_syndicates")}
    rat = {r["key"]: r["payload"] for r in store.rows("ex_ratings")}
    games = {g["id"]: g for g in store.rows("ex_games", {"completed": False})}
    open_trades = store.rows("ex_trades", {"settled": False})
    traded_games = {t["game_id"] for t in open_trades}

    # ---- ingest
    events = espn.window(sports)
    seen_ids = {e["id"] for e in events}
    n_new = 0
    for ev in events:
        ex = games.get(ev["id"])
        has_odds = bool(ev["now"]) and ev["state"] == "pre"
        if ex is None and not has_odds:
            continue
        row = ex or {"id": ev["id"], "sport": ev["sport"], "ref": None, "ref_open": None, "book": None, "voided": False}
        n_new += ex is None
        row.update(start_utc=ev["start"], state=ev["state"], completed=ev["completed"], neutral=ev["neutral"],
                   home={k: ev["home"][k] for k in ("id", "name", "abbr")}, away={k: ev["away"][k] for k in ("id", "name", "abbr")},
                   home_score=ev["home"]["score"], away_score=ev["away"]["score"], detail=ev["detail"], updated_at=_iso(now))
        if has_odds:
            row["ref"] = ev["now"]
            if row["ref_open"] is None:
                row["ref_open"] = ev["open"] or ev["now"]
        games[ev["id"]] = row
    # a traded game that ESPN's window no longer covers is voided after a few days
    for gid in traded_games:
        g = games.get(gid)
        if g and gid not in seen_ids and now - _pdate(g["start_utc"]) > timedelta(days=VOID_AFTER_DAYS):
            g["state"], g["completed"], g["voided"] = "post", True, True

    # ---- reference models
    refs: dict[str, tuple[Dist, float | None]] = {}
    refos: dict[str, Dist | None] = {}
    for gid, g in games.items():
        if g.get("ref"):
            d, ml = pricing.fit(g["sport"], g["ref"])
            if d:
                refs[gid] = (d, ml)
                refos[gid] = pricing.fit(g["sport"], g["ref_open"])[0] if g.get("ref_open") else None

    def p_ref(gid: str, kind: str, line: float) -> float | None:
        r = refs.get(gid)
        if not r:
            return None
        d, ml = r
        return clip(ml) if kind == "ml" and ml is not None else d.p(kind, line)

    # ---- settle
    settled_rows, touched = [], set()
    stats = {"settled": 0, "voided": 0}
    still_open = []
    for t in open_trades:
        g = games.get(t["game_id"])
        done = g and g["completed"] and ((g.get("home_score") is not None and g.get("away_score") is not None) or g.get("voided"))
        if not done:
            still_open.append(t)
            continue
        if g.get("voided") or g["home_score"] is None:
            out = 0.5
        else:
            out = pricing.outcome(t["kind"], t["line"], g["home_score"], g["away_score"])
        t["outcome"], t["settled"] = out, True
        close_p = p_ref(t["game_id"], t["kind"], t["line"])
        t["close_p"] = None if close_p is None else round(close_p, 4)
        for side in ("buyer", "seller"):
            m = members[t[side]]
            cost = t["qty"] * (t["price"] if side == "buyer" else 1 - t["price"])
            win = out if side == "buyer" else 1 - out
            pay = cost if out == 0.5 else t["qty"] * win
            pnl = pay - cost
            m["cash"] += pay
            m["locked"] -= cost
            m["realized"] += pnl
            st = m["stats"]
            role = "maker" if t["maker"] == m["id"] else "taker"
            st[f"pnl_{role}"] += pnl
            if out != 0.5:
                st["wins"] += pnl > 0
                st["losses"] += pnl < 0
            st["biggest"] = max(st.get("biggest", 0.0), cost)
            if close_p is not None:
                st["clv_sum"] += (close_p - t["price"]) if side == "buyer" else (t["price"] - close_p)
                st["clv_n"] += 1
            touched.add(m["id"])
        settled_rows.append(t)
        stats["settled"] += 1
        stats["voided"] += out == 0.5
    open_trades = still_open

    # ---- markets
    lo, hi = now + timedelta(minutes=CUTOFF_MIN), now + timedelta(hours=HORIZON_H)
    markets: dict[str, dict] = {}  # ckey -> {gid, kind, line, ref}
    for gid, g in games.items():
        if g["state"] != "pre" or gid not in refs or not g.get("ref"):
            continue
        if not (lo <= _pdate(g["start_utc"]) <= hi):
            continue
        for kind, line in pricing.lines_for(g["sport"], g["ref"]):
            markets[ckey(gid, kind, line)] = {"gid": gid, "kind": kind, "line": line, "ref": p_ref(gid, kind, line)}

    # ---- each syndicate's view of every market
    eng_p: dict[tuple[str, str], float] = {}
    by_gid: dict[str, list[str]] = {}
    for k, mk in markets.items():
        by_gid.setdefault(mk["gid"], []).append(k)
    for s in syns.values():
        for gid, keys in by_gid.items():
            g, (d, ml) = games[gid], refs[gid]
            dist = engine_dist(s["engine"], g, d, refos.get(gid), rat)
            if dist is None:
                continue
            for k in keys:
                eng_p[(s["id"], k)] = p_engine(dist, d, ml, markets[k]["kind"], markets[k]["line"])

    def fair(m: dict, k: str) -> float:
        mk = markets[k]
        pe = eng_p.get((m["syndicate_id"], k), mk["ref"])
        w = m["params"].get("ref_w", 0.5)
        return clip(w * mk["ref"] + (1 - w) * pe)

    # net positions and exposure from open trades
    net: dict[tuple[str, str], float] = {}
    risk: dict[tuple[str, str], float] = {}
    for t in open_trades:
        k = ckey(t["game_id"], t["kind"], t["line"])
        g_ = (t["game_id"], t["kind"])  # risk is capped per game and market type, so a ladder of lines is one play, not nine
        net[(t["buyer"], k)] = net.get((t["buyer"], k), 0.0) + t["qty"]
        net[(t["seller"], k)] = net.get((t["seller"], k), 0.0) - t["qty"]
        risk[(t["buyer"],) + g_] = risk.get((t["buyer"],) + g_, 0.0) + t["qty"] * t["price"]
        risk[(t["seller"],) + g_] = risk.get((t["seller"],) + g_, 0.0) + t["qty"] * (1 - t["price"])

    # ---- makers quote
    bids: dict[str, list[list]] = {k: [] for k in markets}
    asks: dict[str, list[list]] = {k: [] for k in markets}
    for m in members.values():
        if m["role"] not in ("maker", "both"):
            continue
        p = m["params"]
        kinds = p.get("kinds")
        cap = p["max_risk"] * 1.5
        for k, mk in markets.items():
            if kinds and mk["kind"] not in kinds:
                continue
            if risk.get((m["id"], mk["gid"], mk["kind"]), 0.0) >= cap:
                continue
            q = net.get((m["id"], k), 0.0)
            c = fair(m, k) - p.get("skew", 0.0) * q
            bid, ask = max(0.01, float(np.floor((c - p["half"]) * 100) / 100)), min(0.99, float(np.ceil((c + p["half"]) * 100) / 100))
            if bid >= ask:
                continue
            qb = min(p["size"], (cap - max(q, 0.0) * bid) / bid)
            qa = min(p["size"], (cap - max(-q, 0.0) * (1 - ask)) / (1 - ask))
            if qb >= 1:
                bids[k].append([bid, round(qb, 2), m["id"]])
            if qa >= 1:
                asks[k].append([ask, round(qa, 2), m["id"]])
    for k in markets:
        bids[k].sort(key=lambda x: -x[0])
        asks[k].sort(key=lambda x: x[0])

    # ---- takers hit
    new_trades: list[dict] = []
    last_px: dict[str, float] = {}

    def best(book, me):
        for q in book:
            if q[2] != me and q[1] > 0.01:
                return q
        return None

    takers = [m for m in members.values() if m["role"] in ("taker", "both")]
    rng.shuffle(takers)
    for m in takers:
        p = m["params"]
        thr = p.get("thr", 0.03)
        kinds = p.get("kinds")
        cands = []
        for k, mk in markets.items():
            if kinds and mk["kind"] not in kinds:
                continue
            pf = fair(m, k)
            a, b = best(asks[k], m["id"]), best(bids[k], m["id"])
            if a and pf - a[0] >= thr and net.get((m["id"], k), 0.0) >= 0:
                cands.append((pf - a[0], k, "buy", pf))
            elif b and b[0] - pf >= thr and net.get((m["id"], k), 0.0) <= 0:
                cands.append((b[0] - pf, k, "sell", pf))
        cands.sort(reverse=True)
        for edge, k, side, pf in cands:
            book = asks[k] if side == "buy" else bids[k]
            gk = (m["id"], markets[k]["gid"], markets[k]["kind"])
            left = p["max_risk"] - risk.get(gk, 0.0)
            while left > 0.05:
                q = best(book, m["id"])
                if not q:
                    break
                px = q[0]
                e = (pf - px) if side == "buy" else (px - pf)
                if e < thr:
                    break
                unit = px if side == "buy" else 1 - px
                f = (pf - px) / (1 - px) if side == "buy" else (px - pf) / px
                st = m["staking"]
                bankroll = m["cash"] + m["locked"]
                want = (p["flat"] if st == "flat" else p["kelly"] * f * bankroll if st == "kelly" else p["pct"] * bankroll if st == "pct"
                        else min(p["max_risk"], max(1.0, e * 100 * 0.6)))
                want = min(want, left, m["cash"], MAX_DEPLOY * (m["cash"] + m["locked"]) - m["locked"])
                qty = round(min(want / unit, q[1]), 2)
                maker = members[q[2]]
                if qty < 0.1:
                    break
                mk_ = (maker["id"], markets[k]["gid"], markets[k]["kind"])
                if (maker["cash"] < qty * (1 - unit) or risk.get(mk_, 0.0) + qty * (1 - unit) > maker["params"]["max_risk"] * 1.5
                        or maker["locked"] + qty * (1 - unit) > MAX_DEPLOY * (maker["cash"] + maker["locked"])):
                    q[1] = 0
                    continue
                buyer, seller = (m, maker) if side == "buy" else (maker, m)
                tr = {"id": f"r{rnd}-{len(new_trades)}", "ts": _iso(now), "round": rnd, "game_id": markets[k]["gid"], "kind": markets[k]["kind"],
                      "line": markets[k]["line"], "price": px, "qty": qty, "buyer": buyer["id"], "seller": seller["id"], "maker": maker["id"],
                      "ref_p": round(markets[k]["ref"], 4), "settled": False, "outcome": None, "close_p": None}
                new_trades.append(tr)
                q[1] = round(q[1] - qty, 2)
                last_px[k] = px
                bc, sc = qty * px, qty * (1 - px)
                buyer["cash"] -= bc
                buyer["locked"] += bc
                seller["cash"] -= sc
                seller["locked"] += sc
                for who, c in ((buyer, bc), (seller, sc)):
                    role = "maker" if who["id"] == maker["id"] else "taker"
                    who["stats"][f"n_{role}"] += 1
                    who["stats"][f"vol_{role}"] += c
                    touched.add(who["id"])
                    net[(who["id"], k)] = net.get((who["id"], k), 0.0) + (qty if who is buyer else -qty)
                    risk[(who["id"], markets[k]["gid"], markets[k]["kind"])] = risk.get((who["id"], markets[k]["gid"], markets[k]["kind"]), 0.0) + c
                left -= bc if side == "buy" else sc
    open_all = open_trades + new_trades

    # ---- mark to market
    unreal: dict[str, float] = {}
    open_risk: dict[str, float] = {}
    for t in open_all:
        pr_ = p_ref(t["game_id"], t["kind"], t["line"])
        if pr_ is not None:
            unreal[t["buyer"]] = unreal.get(t["buyer"], 0.0) + t["qty"] * (pr_ - t["price"])
            unreal[t["seller"]] = unreal.get(t["seller"], 0.0) + t["qty"] * (t["price"] - pr_)
        open_risk[t["buyer"]] = open_risk.get(t["buyer"], 0.0) + t["qty"] * t["price"]
        open_risk[t["seller"]] = open_risk.get(t["seller"], 0.0) + t["qty"] * (1 - t["price"])
    snaps = []
    for m in members.values():
        eq = m["cash"] + m["locked"] + unreal.get(m["id"], 0.0)
        m["equity"], m["open_risk"], m["updated_at"] = round(eq, 3), round(open_risk.get(m["id"], 0.0), 3), _iso(now)
        st = m["stats"]
        st["peak"] = max(st["peak"], eq)
        st["max_dd"] = max(st["max_dd"], st["peak"] - eq)
        if rnd % SNAP_EVERY == 0:
            snaps.append({"ts": _iso(now), "subject": f"mem:{m['id']}", "equity": m["equity"], "realized": round(m["realized"], 3), "open_risk": m["open_risk"]})
    if rnd % SNAP_EVERY == 0:
        for sid in syns:
            ms = [m for m in members.values() if m["syndicate_id"] == sid]
            snaps.append({"ts": _iso(now), "subject": f"syn:{sid}", "equity": round(sum(m["equity"] for m in ms), 3),
                          "realized": round(sum(m["realized"] for m in ms), 3), "open_risk": round(sum(m["open_risk"] for m in ms), 3)})

    # ---- the book the page shows
    by_game: dict[str, list] = {}
    for k, mk in markets.items():
        b, a = (bids[k][0][0] if bids[k] else None), (asks[k][0][0] if asks[k] else None)
        by_game.setdefault(mk["gid"], []).append([mk["kind"], mk["line"], round(mk["ref"], 3), b, a, last_px.get(k)])
    for gid, rows in by_game.items():
        games[gid]["book"] = rows

    # ---- write back
    store.upsert("ex_games", list(games.values()))
    if new_trades:
        store.insert("ex_trades", new_trades)
    if settled_rows:
        store.upsert("ex_trades", settled_rows)
    store.upsert("ex_members", list(members.values()))
    if snaps:
        store.insert("ex_snapshots", snaps)
    store.upsert("ex_meta", [{"key": "round", "value": {"n": rnd, "ts": _iso(now), "markets": len(markets), "games": len(by_gid),
                                                         "new_trades": len(new_trades), "settled": stats["settled"]}}])
    store.save()
    out = {"round": rnd, "games_new": n_new, "games_listed": len(by_gid), "markets": len(markets), "new_trades": len(new_trades), **stats, "open": len(open_all)}
    if verbose:
        print(out, flush=True)
    return out
