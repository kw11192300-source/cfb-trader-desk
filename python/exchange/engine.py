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
MAX_DEPLOY = 0.7  # share of a trader's bankroll that may be tied up in open trades
TICKS = 12  # steps of simulated time inside one round
ACT_PROB = 0.6  # chance a trader acts on a given tick after the first
BAND = 0.12  # no fair price strays further than this from the DraftKings price
W0, LAMBDA, W_MAX = 0.25, 0.5, 0.75
# the shared rulebook: limits no strategy can step outside, whatever a trader decides for itself
RULES = dict(max_risk=100.0, kelly=0.25, size=100.0, thr_min=0.01, half_min=0.01, edge_max=0.06)
ADAPT_EVERY = 40  # settled trades of one kind between a trader reviewing its own strategy


def abide(p: dict) -> dict:
    """A trader's strategy, held inside the rulebook."""
    p["max_risk"] = min(p.get("max_risk", RULES["max_risk"]), RULES["max_risk"])
    p["kelly"] = min(p["kelly"], RULES["kelly"])
    p["size"] = min(p["size"], RULES["size"])
    p["thr"] = float(np.clip(p["thr"], RULES["thr_min"], RULES["edge_max"]))
    p["half"] = float(np.clip(p["half"], RULES["half_min"], RULES["edge_max"]))
    return p


def adapt(m: dict, now: str) -> None:
    """Each trader reviews its own results and adjusts its own strategy: if the trades it takes keep closing worse than it paid it asks for a
    bigger edge; if its quotes keep getting picked off it widens them; if both are doing well it tightens up to trade more."""
    st, p = m["stats"], m["params"]
    for role, field, up, down, lo_clv in (("taker", "thr", 0.0, 0.01, "thr_min"), ("maker", "half", 0.0, 0.008, "half_min")):
        n, tot = st.get(f"clv_{role}_n", 0), st.get(f"clv_{role}_sum", 0.0)
        rn, rt = st.get(f"rv_{role}_n", 0), st.get(f"rv_{role}_sum", 0.0)
        if n - rn < ADAPT_EVERY:
            continue
        avg = (tot - rt) / (n - rn)
        old = p[field]
        new = old + 0.0025 if avg < up else old - 0.0025 if avg > down else old
        new = float(np.clip(new, RULES[lo_clv], RULES["edge_max"]))
        st[f"rv_{role}_n"], st[f"rv_{role}_sum"] = n, tot
        if new != old:
            p[field] = round(new, 4)
            p["log"] = ([[now, field, old, p[field], round(avg, 4)]] + p.get("log", []))[:8]
  # cautious starting weight on a syndicate's own model, how much evidence it takes to move it, and its ceiling


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
def syn_weight(s: dict, sport: str) -> float:
    """How much of a syndicate's model goes into its fair price in a sport: the least-squares weight on (model - market) that best explains
    (outcome - market) over every settled game so far, pulled toward a cautious prior while there is little evidence."""
    st = ((s.get("learn") or {}).get("stats") or {}).get(sport) or {}
    return float(np.clip((st.get("num", 0.0) + LAMBDA * W0) / (st.get("den", 0.0) + LAMBDA), 0.0, W_MAX))


def run_round(store, sports: list[str], seed: int | None = None, verbose: bool = True, ticks: int = TICKS) -> dict:
    now = _now()
    meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    rnd = int((meta.get("round") or {}).get("n", 0)) + 1
    rng = random.Random(seed if seed is not None else rnd)
    if not store.rows("ex_members"):
        init(store)
    members = {m["id"]: m for m in store.rows("ex_members")}
    for m in members.values():
        abide(m["params"])
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
        row = ex or {"id": ev["id"], "sport": ev["sport"], "ref": None, "ref_open": None, "book": None, "views": None, "learned": False, "voided": False}
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

    # ---- learn: after a game finishes, score each syndicate's model against the market on its three main lines
    n_learned = 0
    for g in games.values():
        v = g.get("views")
        if not (g["completed"] and v and not g.get("learned") and not g.get("voided") and g.get("home_score") is not None):
            continue
        g["learned"] = True
        for sid, es in (v.get("e") or {}).items():
            if sid not in syns:
                continue
            syns[sid]["learn"] = syns[sid].get("learn") or {}
            st = syns[sid]["learn"].setdefault("stats", {}).setdefault(g["sport"], {"num": 0.0, "den": 0.0, "n": 0})
            for (kind, line), r, e in zip(v["lines"], v["r"], es):
                if r is None or e is None:
                    continue
                o = pricing.outcome(kind, line, g["home_score"], g["away_score"])
                if o == 0.5:
                    continue
                st["num"] += (o - r) * (e - r)
                st["den"] += (e - r) ** 2
                st["n"] += 1
        n_learned += 1

    # ---- settle
    settled_rows = []
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
                c = (close_p - t["price"]) if side == "buyer" else (t["price"] - close_p)
                st["clv_sum"] += c
                st["clv_n"] += 1
                st[f"clv_{role}_sum"] = st.get(f"clv_{role}_sum", 0.0) + c
                st[f"clv_{role}_n"] = st.get(f"clv_{role}_n", 0) + 1
        settled_rows.append(t)
        stats["settled"] += 1
        stats["voided"] += out == 0.5
    open_trades = still_open

    # ---- markets
    lo, hi = now + timedelta(minutes=CUTOFF_MIN), now + timedelta(hours=HORIZON_H)
    markets: dict[str, dict] = {}  # ckey -> {gid, kind, line, ref}
    by_sport: dict[str, list[str]] = {}
    for gid, g in games.items():
        if g["state"] != "pre" or gid not in refs or not g.get("ref"):
            continue
        if not (lo <= _pdate(g["start_utc"]) <= hi):
            continue
        for kind, line in pricing.lines_for(g["sport"], g["ref"]):
            k = ckey(gid, kind, line)
            markets[k] = {"gid": gid, "kind": kind, "line": line, "ref": p_ref(gid, kind, line)}
            by_sport.setdefault(g["sport"], []).append(k)
    by_gid: dict[str, list[str]] = {}
    for k, mk in markets.items():
        by_gid.setdefault(mk["gid"], []).append(k)

    # ---- every syndicate's model view of every market, and the one shared way a view becomes a fair price
    eng_p: dict[tuple[str, str], float] = {}
    for gid, keys in by_gid.items():
        g, (d, ml) = games[gid], refs[gid]
        views = {"lines": [], "r": [], "e": {}}
        for kd, ln in [("ml", 0.0), ("spread", g["ref"].get("spread")), ("total", g["ref"].get("total"))]:
            if ln is not None and ckey(gid, kd, ln) in markets:
                views["lines"].append([kd, ln])
                views["r"].append(round(markets[ckey(gid, kd, ln)]["ref"], 4))
        for s in syns.values():
            dist = engine_dist(s["engine"], g, d, refos.get(gid), rat)
            if dist is None:
                continue
            for k in keys:
                eng_p[(s["id"], k)] = p_engine(dist, d, ml, markets[k]["kind"], markets[k]["line"])
            views["e"][s["id"]] = [round(eng_p[(s["id"], ckey(gid, kd, ln))], 4) for kd, ln in views["lines"]]
        g["views"] = views if views["lines"] else None
    weights = {(sid, sp): syn_weight(s, sp) for sid, s in syns.items() for sp in espn.SPORTS}

    def fair(m: dict, k: str) -> float:
        mk = markets[k]
        sid = m["syndicate_id"]
        e = eng_p.get((sid, k), mk["ref"])
        w = float(np.clip(m["params"].get("trust", 1.0) * weights[(sid, k.split(":")[0])], 0.0, W_MAX))
        f = mk["ref"] + w * (e - mk["ref"])
        return clip(f, mk["ref"] - BAND, mk["ref"] + BAND)

    fairs = {(m["id"], k): fair(m, k) for m in members.values() for k in (kk for sp in m["params"].get("sports", []) for kk in by_sport.get(sp, []))}
    my_keys = {m["id"]: [k for sp in m["params"].get("sports", []) for k in by_sport.get(sp, [])
                         if not m["params"].get("kinds") or markets[k]["kind"] in m["params"]["kinds"]] for m in members.values()}

    # net positions and exposure from open trades
    net: dict[tuple[str, str], float] = {}
    risk: dict[tuple[str, str, str], float] = {}
    for t in open_trades:
        k = ckey(t["game_id"], t["kind"], t["line"])
        g_ = (t["game_id"], t["kind"])  # risk is capped per game and market type, so a ladder of lines is one play, not nine
        net[(t["buyer"], k)] = net.get((t["buyer"], k), 0.0) + t["qty"]
        net[(t["seller"], k)] = net.get((t["seller"], k), 0.0) - t["qty"]
        risk[(t["buyer"],) + g_] = risk.get((t["buyer"],) + g_, 0.0) + t["qty"] * t["price"]
        risk[(t["seller"],) + g_] = risk.get((t["seller"],) + g_, 0.0) + t["qty"] * (1 - t["price"])

    bids: dict[str, list[list]] = {k: [] for k in markets}
    asks: dict[str, list[list]] = {k: [] for k in markets}
    new_trades: list[dict] = []
    last_px: dict[str, float] = {}
    first_px: dict[str, float] = {}

    def post_quotes(m: dict) -> None:
        """Cancel and re-post this trader's quotes: a bid and an ask either side of its fair price, leaned away from any position it holds."""
        p = m["params"]
        cap = p["max_risk"] * 1.5
        for k in my_keys[m["id"]]:
            bids[k] = [q for q in bids[k] if q[2] != m["id"]]
            asks[k] = [q for q in asks[k] if q[2] != m["id"]]
            mk = markets[k]
            if risk.get((m["id"], mk["gid"], mk["kind"]), 0.0) >= cap:
                continue
            q = net.get((m["id"], k), 0.0)
            c = fairs[(m["id"], k)] - p["skew"] * q
            bid, ask = max(0.01, float(np.floor((c - p["half"]) * 100) / 100)), min(0.99, float(np.ceil((c + p["half"]) * 100) / 100))
            if bid >= ask:
                continue
            qb = min(p["size"], (cap - max(q, 0.0) * bid) / bid)
            qa = min(p["size"], (cap - max(-q, 0.0) * (1 - ask)) / (1 - ask))
            if qb >= 5:
                bids[k].append([bid, round(qb, 2), m["id"]])
                bids[k].sort(key=lambda x: -x[0])
            if qa >= 5:
                asks[k].append([ask, round(qa, 2), m["id"]])
                asks[k].sort(key=lambda x: x[0])

    def best(book, me):
        for q in book:
            if q[2] != me and q[1] > 0.5:
                return q
        return None

    def take(m: dict) -> None:
        p = m["params"]
        thr = p["thr"]
        cands = []
        for k in my_keys[m["id"]]:
            pf = fairs[(m["id"], k)]
            a, b = best(asks[k], m["id"]), best(bids[k], m["id"])
            if a and pf - a[0] >= thr and net.get((m["id"], k), 0.0) >= 0:
                cands.append((pf - a[0], k, "buy", pf))
            elif b and b[0] - pf >= thr and net.get((m["id"], k), 0.0) <= 0:
                cands.append((b[0] - pf, k, "sell", pf))
        cands.sort(reverse=True)
        for edge, k, side, pf in cands:
            book = asks[k] if side == "buy" else bids[k]
            mk = markets[k]
            gk = (m["id"], mk["gid"], mk["kind"])
            left = p["max_risk"] - risk.get(gk, 0.0)
            while left > 1.0:
                q = best(book, m["id"])
                if not q:
                    break
                px = q[0]
                e = (pf - px) if side == "buy" else (px - pf)
                if e < thr:
                    break
                unit = px if side == "buy" else 1 - px
                f = (pf - px) / (1 - px) if side == "buy" else (px - pf) / px
                bankroll = m["cash"] + m["locked"]
                want = min(p["kelly"] * f * bankroll, left, m["cash"], MAX_DEPLOY * bankroll - m["locked"])
                qty = round(min(want / unit, q[1]), 2)
                if qty < 1:
                    break
                maker = members[q[2]]
                mcost = qty * (1 - unit)
                if (maker["cash"] < mcost or risk.get((maker["id"], mk["gid"], mk["kind"]), 0.0) + mcost > maker["params"]["max_risk"] * 1.5
                        or maker["locked"] + mcost > MAX_DEPLOY * (maker["cash"] + maker["locked"])):
                    q[1] = 0
                    continue
                buyer, seller = (m, maker) if side == "buy" else (maker, m)
                new_trades.append({"id": f"r{rnd}-{len(new_trades)}", "ts": _iso(now), "round": rnd, "game_id": mk["gid"], "kind": mk["kind"],
                                   "line": mk["line"], "price": px, "qty": qty, "buyer": buyer["id"], "seller": seller["id"], "maker": maker["id"],
                                   "ref_p": round(mk["ref"], 4), "settled": False, "outcome": None, "close_p": None})
                q[1] = round(q[1] - qty, 2)
                last_px[k] = px
                first_px.setdefault(k, px)
                bc, sc = qty * px, qty * (1 - px)
                buyer["cash"] -= bc
                buyer["locked"] += bc
                seller["cash"] -= sc
                seller["locked"] += sc
                for who, c in ((buyer, bc), (seller, sc)):
                    role = "maker" if who["id"] == maker["id"] else "taker"
                    who["stats"][f"n_{role}"] += 1
                    who["stats"][f"vol_{role}"] += c
                    net[(who["id"], k)] = net.get((who["id"], k), 0.0) + (qty if who is buyer else -qty)
                    risk[(who["id"], mk["gid"], mk["kind"])] = risk.get((who["id"], mk["gid"], mk["kind"]), 0.0) + c
                left -= bc if side == "buy" else sc

    # ---- time flows: traders arrive in random order over a number of ticks, refresh their quotes, and hit each other's
    order = list(members.values())
    rng.shuffle(order)
    for m in order:
        post_quotes(m)
    for tick in range(ticks):
        rng.shuffle(order)
        for m in order:
            if tick > 0 and rng.random() > ACT_PROB:
                continue
            if tick > 0:
                post_quotes(m)
            take(m)
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
    for sid, s in syns.items():
        s["learn"] = s.get("learn") or {}
        s["learn"]["w"] = {sp: round(weights[(sid, sp)], 3) for sp in espn.SPORTS}
        if rnd % SNAP_EVERY == 0:
            ms = [m for m in members.values() if m["syndicate_id"] == sid]
            snaps.append({"ts": _iso(now), "subject": f"syn:{sid}", "equity": round(sum(m["equity"] for m in ms), 3),
                          "realized": round(sum(m["realized"] for m in ms), 3), "open_risk": round(sum(m["open_risk"] for m in ms), 3)})

    for m in members.values():
        adapt(m, _iso(now))

    # ---- the book the page shows: [kind, line, fair, best bid, best ask, last trade, first trade this round]
    by_game: dict[str, list] = {}
    for k, mk in markets.items():
        b, a = (bids[k][0][0] if bids[k] else None), (asks[k][0][0] if asks[k] else None)
        by_game.setdefault(mk["gid"], []).append([mk["kind"], mk["line"], round(mk["ref"], 3), b, a, last_px.get(k), first_px.get(k)])
    for gid, rows in by_game.items():
        games[gid]["book"] = rows

    # ---- write back
    store.upsert("ex_games", list(games.values()))
    if new_trades:
        store.insert("ex_trades", new_trades)
    if settled_rows:
        store.upsert("ex_trades", settled_rows)
    store.upsert("ex_members", list(members.values()))
    store.upsert("ex_syndicates", list(syns.values()))
    if snaps:
        store.insert("ex_snapshots", snaps)
    store.upsert("ex_meta", [{"key": "round", "value": {"n": rnd, "ts": _iso(now), "markets": len(markets), "games": len(by_gid),
                                                         "new_trades": len(new_trades), "settled": stats["settled"], "ticks": ticks}}])
    store.save()
    out = {"round": rnd, "games_new": n_new, "games_listed": len(by_gid), "markets": len(markets), "new_trades": len(new_trades), **stats,
           "learned": n_learned, "open": len(open_all)}
    if verbose:
        print(out, flush=True)
    return out
