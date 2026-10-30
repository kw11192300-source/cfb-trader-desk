"""One round of the exchange: ingest ESPN, settle finished games, let makers quote, let takers hit, mark everyone to market.

Contracts are binary and pay 1 unit: 'yes' is home moneyline / home covers at the home line / over the total. The buyer posts the price,
the seller posts 1 - price as collateral. Offsetting trades on the same contract net off (first in, first out) and bank their profit at
once. Risk is the worst case across every possible result (risk.py), not the collateral, and is limited per game and in total, with a cash
reserve that is never committed. Trades happen at the maker's price. A push refunds both.
"""
from __future__ import annotations

import random
import time
from datetime import datetime, timedelta, timezone

import numpy as np

from . import espn, house, kalshi, pricing, ratings, results, risk
from .agents import manage as agent_manage, sandbox as agent_sandbox
from .members import roster
from .pricing import Dist, ckey, clip

HORIZON_H = 168  # a week out
HORIZON_BY_SPORT = {"nfl": 336}  # the NFL's slate is small, so look two weeks ahead


def horizon(sport: str) -> int:
    return HORIZON_BY_SPORT.get(sport, HORIZON_H)
SRC_LIMIT = {"dk": 1.0, "exchange": 0.25, "kalshi": 0.25, "model": 0.25}  # a game DraftKings has not priced gets a quarter of the usual limits while the syndicates make its line
CENTER_ETA = 0.7  # how far the exchange's line moves toward where the traders cleared it each round
CENTER_STEP = 0.15  # ...but never more than this share of a standard deviation in one round
CENTER_DRIFT = 1.0  # ...and never more than this far from where it opened
CBB_NODK_CAP = 30  # college basketball has hundreds of games a day: only the next few that DraftKings has not priced are opened
W_FLOOR_EXCH = 0.5  # with no market to anchor to, a syndicate trusts its own model at least this much
CUTOFF_MIN = 3
SNAP_EVERY = 3  # rounds between equity snapshots
VOID_AFTER_DAYS = 6
TOTAL_FRAC = 0.30  # worst-case loss, summed over a trader's games, may not pass this share of its bankroll
SYN_GAME = 150.0  # a syndicate's combined worst case on one game, all its traders together, at the kickoff end of the ramp
TAKE_CLIP = 40.0  # most contracts a trader will take in one go
MAX_FILLS = 2  # most hits a trader makes each time it acts
IMPACT = 0.03  # a full-strength sharp trader's full-size trade moves everyone's view of the game by this share of a standard deviation
IMPACT_Q = 50.0  # contracts that count as a full-size trade
FLOW_DECAY = 0.6  # how much of that market move is still felt a round later
SHARP_CLV = 0.02  # average closing-line value (2 cents) that makes a taker fully "sharp"
SHARP_N = 10.0  # effective trades of evidence before a taker's record counts in full
MM_REACT = 2.0  # a market maker moves its own view of a game this many times harder than a follower when its quote is hit
MAKER_SOFT = 0.6  # a market maker stops offering new risk once it has used this share of its risk limit, so it always has room to keep quoting
RESERVE_FRAC = 0.20  # share of its starting bankroll a trader never commits as cash
TICKS = 12  # steps of simulated time inside one round
ACT_PROB = 0.6  # chance a trader acts on a given tick after the first
BAND = 0.12  # no fair price strays further than this from the DraftKings price
W_MIN_GAMES, W_FULL_GAMES = 12, 40  # games a syndicate needs in a sport before its weight moves at all, and before the data count in full
UNPROVEN_EDGE = 0.008  # a little extra edge a taker asks for while its syndicate's model has not earned a weight (the main brake is smaller size, below)
UNPROVEN_SIZE = 0.6  # an unproven model's takers trade at this share of normal size, rising to full as the weight is earned
CAP_BASE, CAP_FULL = 100.0, 200.0  # a syndicate's per-game limit starts here and grows to the full limit as its closing-line value proves out
SPORT_BONUS = 0.5  # a trader whose takes have beaten the close in a sport gets up to this much more room on that sport's games (and so does its syndicate)
PATIENCE_STEP, PATIENCE_MAX = 0.05, 6  # every round a trader goes without a trade it asks for 5% less edge (or quotes 5% tighter), up to six rounds' worth
PUBLIC_CAP = 500.0  # the public-money firm's combined worst case on one game: a crowd is bigger than any one desk
PUBLIC_RATE = 0.02  # bets per trader per step for each unit of "game-time weight" on the slate (see pub_time)
PUBLIC_FLOOR, PUBLIC_MAX = 0.12, 6  # a little action even on a quiet slate, and the most bets one trader makes in a step
PUBLIC_REACT = 0.15  # how much a market maker moves its price when a public bettor hits it (against 0.5 to 1.5 for everyone else, by reputation)
SQ_TOL = 0.6  # a maker counts inventory it took from public bettors at this much less when deciding how hard to lean its quotes
W0, LAMBDA, W_MAX = 0.25, 0.5, 0.75  # cautious starting weight on a syndicate's own model, how much evidence it takes to move it, its ceiling
# the shared rulebook: limits no strategy can step outside, whatever a trader decides for itself
RULES = dict(max_risk=100.0, kelly=0.25, size=100.0, thr_min=0.01, half_min=0.006, edge_max=0.06)
ADAPT_EVERY = 40  # settled trades of one kind between a trader reviewing its own strategy


def ramp(hours: float) -> float:
    """How much of a game's risk limit can be used this far from kickoff: money arrives as the game gets closer, like a real market."""
    return 0.1 if hours > 72 else 0.15 if hours > 24 else 0.3 if hours > 12 else 0.5 if hours > 6 else 0.75 if hours > 2 else 1.0


def abide(p: dict) -> dict:
    """A trader's strategy, held inside the rulebook."""
    if p.get("public"):  # a public bettor has a fixed temperament and a bigger limit; it is not tuned from results
        p["max_risk"] = min(p.get("max_risk", 200.0), 200.0)
        return p
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
    if p.get("public"):
        return
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


def reset(store) -> None:
    """Start the exchange from scratch: no trades, games, price history or snapshots; every trader back to its starting bankroll, strategy and
    record; every syndicate's learned model weight back to the cautious start. Fitted ratings and the labs' published models are kept."""
    for t in ("ex_trades", "ex_snapshots", "ex_marks", "ex_games", "ex_meta"):
        store.clear(t)
    fits = [r["fitted_at"] for r in store.rows("ex_ratings") if r["key"].split("|")[0] in espn.SPORTS and r.get("fitted_at")]
    if fits:  # the ratings survive a reset, so the record of when they were fitted does too
        store.upsert("ex_meta", [{"key": "ratings", "value": {"ts": max(fits), "sports": espn.SPORTS}}])
    old = {s["id"]: s for s in store.rows("ex_syndicates")}
    syns, mems = roster()
    for s in syns:
        keep = ((old.get(s["id"]) or {}).get("learn") or {}).get("agent")
        if keep:  # a lab keeps what it has published: version, notes, backtest
            s["learn"] = {"agent": keep}
    store.upsert("ex_syndicates", syns)
    store.upsert("ex_members", mems)
    store.save()


def fit_ratings(store, sports: list[str], days: int = 420) -> None:
    hist: dict[str, list[dict]] = {}
    for sp in sports:
        games = espn.history(sp, days)
        hist[sp] = games
        fits = ratings.fit_all(sp, games)
        rows = [{"key": f"{sp}|{eng}", "payload": pl, "fitted_at": _iso(_now())} for eng, pl in fits.items() if pl]
        store.upsert("ex_ratings", rows)
        print(f"  {sp}: {len(games)} finished games -> {', '.join(r['key'] for r in rows)}", flush=True)
    try:
        print("  housekeeping:", results.prune(store), flush=True)
    except Exception as e:
        print(f"  (housekeeping skipped: {str(e)[:120]})", flush=True)
    agent_manage.refit_portable(store, hist)  # agent models that learn from ESPN results alone are refit with the same fresh histories
    store.upsert("ex_meta", [{"key": "ratings", "value": {"ts": _iso(_now()), "sports": list(hist)}}])
    store.save()


# ---------------------------------------------------------------- engines
def engine_dist(engine: str, g: dict, refd: Dist, refo: Dist | None, rat: dict, sid: str = "") -> Dist | None:
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
    if engine == "house":  # the site's own models, read from its tables once per round
        r = (rat.get("housepred") or {}).get(g["id"])
        return Dist(sp, float(r[0]), float(r[1])) if r else None
    if engine == "agent":  # an agent-built model: its predictions for this round were computed once, in its sandbox
        r = (rat.get(f"agentpred:{sid}") or {}).get(g["id"])
        return Dist(sp, float(r[0]), float(r[1])) if r else None
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
    games = st.get("g", st.get("n", 0) / 3.0)  # a game's three main lines are one piece of evidence, not three
    raw = float(np.clip((st.get("num", 0.0) + LAMBDA * W0) / (st.get("den", 0.0) + LAMBDA), 0.0, W_MAX))
    if games < W_MIN_GAMES:
        return W0
    return W0 + min(1.0, games / W_FULL_GAMES) * (raw - W0)  # the weight moves toward what the data say only as the games pile up


def run_round(store, sports: list[str], seed: int | None = None, verbose: bool = True, ticks: int = TICKS) -> dict:
    t_start = time.time()
    now = _now()
    meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    rnd = int((meta.get("round") or {}).get("n", 0)) + 1
    rng = random.Random(seed if seed is not None else rnd)
    if len(store.rows("ex_syndicates")) < len(roster()[0]) or not store.rows("ex_members"):
        init(store)  # first run, or a syndicate was added to the roster since
    members = {m["id"]: m for m in store.rows("ex_members")}
    for m in members.values():
        abide(m["params"])
    syns = {s["id"]: s for s in store.rows("ex_syndicates")}
    rat = {r["key"]: r["payload"] for r in store.rows("ex_ratings")}
    games = {g["id"]: g for g in store.rows("ex_games", {"completed": False})}
    open_trades = store.rows("ex_trades", {"settled": False})
    for t in open_trades:
        if t.get("rem_b") is None:
            t["rem_b"] = t["qty"]
        if t.get("rem_s") is None:
            t["rem_s"] = t["qty"]
    traded_games = {t["game_id"] for t in open_trades}

    # ---- ingest
    events = espn.window(sports)
    seen_ids = {e["id"] for e in events}
    n_new = 0
    discoveries: list[dict] = []
    pending: dict[str, dict] = {}  # upcoming games with no DraftKings line yet: kept only if a baseline price can be built for them
    for ev in events:
        ex = games.get(ev["id"])
        has_odds = bool(ev["now"]) and ev["state"] == "pre"
        cand = not has_odds and ev["state"] == "pre" and _pdate(ev["start"]) <= now + timedelta(hours=horizon(ev["sport"]))
        if ex is None and not has_odds and not cand:
            continue
        row = ex or {"id": ev["id"], "sport": ev["sport"], "ref": None, "ref_open": None, "book": None, "views": None, "learned": False, "voided": False}
        row.update(start_utc=ev["start"], state=ev["state"], completed=ev["completed"], neutral=ev["neutral"],
                   home={k: ev["home"][k] for k in ("id", "name", "abbr")}, away={k: ev["away"][k] for k in ("id", "name", "abbr")},
                   home_score=ev["home"]["score"], away_score=ev["away"]["score"], detail=ev["detail"], updated_at=_iso(now))
        if has_odds:
            old_ref = row["ref"] or {}
            if old_ref.get("src") in ("exchange", "kalshi", "model") and old_ref.get("rounds", 0) >= 1:  # DraftKings has just priced a game the syndicates were making a line on
                dk_d = pricing.fit(ev["sport"], ev["now"])[0]
                if dk_d:
                    discoveries.append({"id": ev["id"], "sport": ev["sport"], "teams": f"{ev['away']['abbr']} @ {ev['home']['abbr']}", "start": ev["start"], "found": _iso(now),
                                        "hours_before": round((_pdate(ev["start"]) - now).total_seconds() / 3600, 1), "rounds": old_ref.get("rounds"),
                                        "seed": old_ref.get("seed"), "internal": old_ref.get("mt"), "dk": [round(dk_d.m, 3), round(dk_d.t, 3)],
                                        "int_line": [old_ref.get("spread"), old_ref.get("total")], "dk_line": [ev["now"].get("spread"), ev["now"].get("total")]})
            if row["ref_open"] is None or old_ref.get("src", "dk") != "dk":  # the first real DraftKings line becomes the open
                row["ref_open"] = ev["open"] or ev["now"]
            row["ref"] = ev["now"]
        if has_odds or ex is not None:
            games[ev["id"]] = row
            n_new += ex is None
        else:
            pending[ev["id"]] = row
    # a traded game that ESPN's window no longer covers is voided after a few days
    for gid in traded_games:
        g = games.get(gid)
        if g and gid not in seen_ids and now - _pdate(g["start_utc"]) > timedelta(days=VOID_AFTER_DAYS):
            g["state"], g["completed"], g["voided"] = "post", True, True

    # a college basketball game inside the window that ESPN's feed no longer lists (an exhibition against a non-Division I school, now filtered out) is voided:
    # trades on it are refunded and it stops being offered. Only when the feed looks healthy, so an ESPN hiccup cannot void real games.
    if sum(1 for e in events if e["sport"] == "cbb") >= 20:
        for gid, g in games.items():
            if g["sport"] == "cbb" and g["state"] == "pre" and gid not in seen_ids and now - timedelta(days=2) <= _pdate(g["start_utc"]) <= now + timedelta(days=7):
                g["state"], g["completed"], g["voided"] = "post", True, True

    # ---- upcoming games DraftKings has not priced yet: no outside baseline. The line opens at what the rating models agree on, and from then on it is wherever
    # the traders' own quotes and trades clear it (moved at the end of every round). Kalshi's prices are still collected, but only as one syndicate's view.
    pre = {gid: g for gid, g in {**games, **pending}.items() if g["state"] == "pre" and _pdate(g["start_utc"]) <= now + timedelta(hours=horizon(g["sport"]))}
    def opening(g: dict) -> tuple[float, float] | None:
        sp = g["sport"]
        rs = [r for r in (ratings.predict(e, rat.get(f"{sp}|{e}"), g["home"]["id"], g["away"]["id"], bool(g.get("neutral"))) for e in ("elo", "ridge_long", "ridge_short")) if r]
        return (float(np.mean([r[0] for r in rs])), float(np.mean([r[1] for r in rs]))) if len(rs) >= 2 else None

    n_cbb = 0
    for gid, g in sorted(pre.items(), key=lambda kv: kv[1]["start_utc"]):
        r = g.get("ref")
        src = (r or {}).get("src") or ("dk" if r else None)
        if src in ("dk", "exchange"):
            n_cbb += src == "exchange" and g["sport"] == "cbb"
            continue
        if src in ("kalshi", "model"):  # a baseline from an earlier version: adopt it as the opening line
            d0 = pricing.fit(g["sport"], r)[0]
            mt = (d0.m, d0.t) if d0 else None
        elif g["sport"] == "cbb" and n_cbb >= CBB_NODK_CAP:
            mt = None
        else:
            mt = opening(g)
            n_cbb += mt is not None and g["sport"] == "cbb"
        if mt is None:
            pending.pop(gid, None)
            if gid in games:
                g["ref"] = None
            continue
        snap = pricing.synth_snap(g["sport"], mt[0], mt[1])
        snap.update(src="exchange", mt=[round(mt[0], 3), round(mt[1], 3)], seed=[round(mt[0], 3), round(mt[1], 3)], rounds=0)
        g["ref"] = snap
        if g.get("ref_open") is None:
            g["ref_open"] = snap
        if gid in pending:
            games[gid] = pending.pop(gid)
            n_new += 1

    try:  # Kalshi's prices for the games that are listed, for the one syndicate that follows them and for the labs
        kal_raw = kalshi.fetch({gid: g for gid, g in games.items() if g["state"] == "pre" and g.get("ref")})
    except Exception:  # Kalshi being down must not stop a round
        kal_raw = {}

    # ---- reference models
    refs: dict[str, tuple[Dist, float | None]] = {}
    refos: dict[str, Dist | None] = {}
    def ref_dist(sport: str, snap: dict) -> tuple[Dist | None, float | None]:
        if snap.get("mt"):  # the exchange's own line: its centre is stored exactly
            d = Dist(sport, snap["mt"][0], snap["mt"][1])
            return d, d.p_ml()
        return pricing.fit(sport, snap)

    for gid, g in games.items():
        if g.get("ref"):
            d, ml = ref_dist(g["sport"], g["ref"])
            if d:
                refs[gid] = (d, ml)
                refos[gid] = ref_dist(g["sport"], g["ref_open"])[0] if g.get("ref_open") else None

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
        if not (g["completed"] and v and not g.get("learned") and not g.get("voided") and g.get("home_score") is not None and v.get("src", "dk") == "dk"):
            continue
        g["learned"] = True
        for sid, es in (v.get("e") or {}).items():
            if sid not in syns:
                continue
            syns[sid]["learn"] = syns[sid].get("learn") or {}
            st = syns[sid]["learn"].setdefault("stats", {}).setdefault(g["sport"], {"num": 0.0, "den": 0.0, "n": 0})
            st["g"] = st.get("g", st["n"] / 3.0) + 1
            for (kind, line), r, e in zip(v["lines"], v["r"], es):
                if r is None or e is None:
                    continue
                o = pricing.outcome(kind, line, g["home_score"], g["away_score"])
                if o == 0.5:
                    continue
                st["num"] += (o - r) * (e - r)
                st["den"] += (e - r) ** 2
                st["n"] += 1
                cal = syns[sid]["learn"].setdefault("calib", {}).setdefault(g["sport"], {"model": [[0, 0.0] for _ in range(10)], "market": [[0, 0.0] for _ in range(10)]})
                for who, pr in (("model", e), ("market", r)):
                    b = cal[who][min(9, int(pr * 10))]
                    b[0] += 1
                    b[1] += o
        n_learned += 1

    # ---- settle: what each side still holds pays out; what was netted off earlier was already banked
    settled_rows = []
    settled_by_game: dict[str, list[dict]] = {}
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
        # closing-line value against the best closing price there is: DraftKings' last line if it priced the game, otherwise the line the syndicates themselves had made by kickoff
        close_p = p_ref(t["game_id"], t["kind"], t["line"])
        t["close_p"] = None if close_p is None else round(close_p, 4)
        for side in ("buyer", "seller"):
            m = members[t[side]]
            rem = t["rem_b"] if side == "buyer" else t["rem_s"]
            cost = rem * (t["price"] if side == "buyer" else 1 - t["price"])
            win = out if side == "buyer" else 1 - out
            pay = cost if out == 0.5 else rem * win
            pnl = pay - cost
            m["cash"] += pay
            m["locked"] -= cost
            m["realized"] += pnl
            st = m["stats"]
            role = "maker" if t["maker"] == m["id"] else "taker"
            st[f"pnl_{role}"] += pnl
            if out != 0.5 and rem > 0:
                st["wins"] += pnl > 0
                st["losses"] += pnl < 0
            st["biggest"] = max(st.get("biggest", 0.0), t["qty"] * (t["price"] if side == "buyer" else 1 - t["price"]))
            if close_p is not None:
                c = (close_p - t["price"]) if side == "buyer" else (t["price"] - close_p)
                st["clv_sum"] += c
                st["clv_sq"] = st.get("clv_sq", 0.0) + c * c
                st["clv_n"] += 1
                st[f"clv_{role}_sum"] = st.get(f"clv_{role}_sum", 0.0) + c
                st[f"clv_{role}_n"] = st.get(f"clv_{role}_n", 0) + 1
                if role == "taker":  # the track record other traders read: closing-line value on what this trader chose to hit, by sport
                    fl = st.setdefault("flow", {}).setdefault(g["sport"], {"s": 0.0, "w": 0.0, "n": 0})
                    fl["s"], fl["w"], fl["n"] = fl["s"] * 0.97 + c, fl["w"] * 0.97 + 1.0, fl["n"] + 1
        settled_rows.append(t)
        settled_by_game.setdefault(t["game_id"], []).append(t)
        stats["settled"] += 1
        stats["voided"] += out == 0.5
    open_trades = still_open
    result_rows = []
    for gid, trs in settled_by_game.items():  # the historical record of each finished game, from its whole trade ledger
        if not games[gid].get("voided"):
            row = results.game_result(games[gid], trs, members)
            result_rows.append(row)
            for mid, v in row["traders"].items():
                ms_ = members[mid]["stats"]
                ms_["s_pnl"] = ms_.get("s_pnl", 0.0) + v["pnl"]
                ms_["s_traded"] = ms_.get("s_traded", 0.0) + v["traded"]
                ms_["s_games"] = ms_.get("s_games", 0) + 1

    # ---- markets
    lo = now + timedelta(minutes=CUTOFF_MIN)
    markets: dict[str, dict] = {}  # ckey -> {gid, sport, kind, line, ref, near, dim, ov}
    for gid, g in games.items():
        if g["state"] != "pre" or gid not in refs or not g.get("ref"):
            continue
        if not (lo <= _pdate(g["start_utc"]) <= now + timedelta(hours=horizon(g["sport"]))):
            continue
        offered = pricing.lines_for(g["sport"], g["ref"])
        if g["ref"].get("src") == "exchange":
            have = set(offered)
            offered += [(r[0], r[1]) for r in (g.get("book") or []) if (r[0], r[1]) not in have][:30]
        for kind, line in offered:
            main = g["ref"].get("spread" if kind == "spread" else "total")
            k = ckey(gid, kind, line)
            srcf = SRC_LIMIT[(g["ref"].get("src") or "dk")]
            markets[k] = {"gid": gid, "sport": g["sport"], "kind": kind, "line": line, "ref": p_ref(gid, kind, line), "srcf": srcf, "src": g["ref"].get("src") or "dk",
                          "hrs": (_pdate(g["start_utc"]) - now).total_seconds() / 3600,
                          "ramp": ramp((_pdate(g["start_utc"]) - now).total_seconds() / 3600),
                          "near": kind == "ml" or (main is not None and abs(line - main) <= 2)}
    by_gid: dict[str, list[str]] = {}
    for k, mk in markets.items():
        by_gid.setdefault(mk["gid"], []).append(k)
    prev_eco: dict[str, float] = {}  # the exchange's own price last round: a market maker's starting point carries what the crowd has already learned
    for gid in by_gid:
        for row in games[gid].get("book") or []:
            if len(row) > 9 and row[9] is not None:
                prev_eco[ckey(gid, row[0], row[1])] = row[9]
    # one grid of possible results per game, wide enough for every line anyone holds as well as every line on offer
    grids: dict[str, risk.Grid] = {}
    glines: dict[str, set] = {}
    for mk in markets.values():
        glines.setdefault(mk["gid"], set()).add((mk["kind"], mk["line"]))
    for t in open_trades:
        glines.setdefault(t["game_id"], set()).add((t["kind"], t["line"]))
    for gid, ls in glines.items():
        grids[gid] = risk.Grid(ls)
    for mk in markets.values():
        mk["dim"], mk["ov"] = grids[mk["gid"]].outcome(mk["kind"], mk["line"])

    # ---- agent-built models predict once per round, in a restricted subprocess; one that fails simply abstains
    for sid, s in syns.items():
        if s["engine"] != "agent":
            continue
        a = (s.get("learn") or {}).setdefault("agent", {})
        code, state = rat.get(f"agent-code:{sid}"), rat.get(f"agent-state:{sid}")
        if not code or not state or not by_gid:
            continue
        slate = [agent_manage.game_payload(games[gid], bool(a.get("lines"))) for gid in by_gid]
        try:
            rat[f"agentpred:{sid}"] = agent_sandbox.call(code["code"], "predict", timeout=180, state=state["state"], games=slate)
            a["error"] = None
        except agent_sandbox.ModelError as e:
            a["error"] = str(e)[-300:]
    if any(s["engine"] == "house" for s in syns.values()):
        rat["housepred"] = house.fetch(store, list(by_gid))
    # Kalshi's real-money prices for the same games, translated into our contracts (a mid wherever both sides are posted and tight)
    kal: dict[str, dict[tuple[str, float], list]] = {}
    if by_gid:
        raw = {gid: kal_raw.get(gid, []) for gid in by_gid}
        for gid, rows in raw.items():
            kal[gid] = {(r[0], r[1]): r for r in rows if ckey(gid, r[0], r[1]) in markets}
    # ---- every syndicate's model view of every market, and the one shared way a view becomes a fair price
    eng_p: dict[tuple[str, str], float] = {}
    marks = []
    prev_views: dict[str, dict | None] = {}
    for gid, keys in by_gid.items():
        g, (d, ml) = games[gid], refs[gid]
        views = {"lines": [], "r": [], "e": {}, "src": g["ref"].get("src") or "dk"}
        for kd, ln in [("ml", 0.0), ("spread", pricing.main_half(g["ref"].get("spread"))), ("total", pricing.main_half(g["ref"].get("total")))]:
            if ln is not None and ckey(gid, kd, ln) in markets:
                views["lines"].append([kd, ln])
                views["r"].append(round(markets[ckey(gid, kd, ln)]["ref"], 4))
        for s in syns.values():
            if s["engine"] == "kalshi":  # no model: Kalshi's mid is its view wherever Kalshi has a price, DraftKings elsewhere
                for k in keys:
                    r = kal.get(gid, {}).get((markets[k]["kind"], markets[k]["line"]))
                    eng_p[(s["id"], k)] = r[2] if r else markets[k]["ref"]
                views["e"][s["id"]] = [round(eng_p[(s["id"], ckey(gid, kd, ln))], 4) for kd, ln in views["lines"]]
                continue
            dist = engine_dist(s["engine"], g, d, refos.get(gid), rat, s["id"])
            if dist is None:
                continue
            for k in keys:
                eng_p[(s["id"], k)] = p_engine(dist, d, ml, markets[k]["kind"], markets[k]["line"])
            views["e"][s["id"]] = [round(eng_p[(s["id"], ckey(gid, kd, ln))], 4) for kd, ln in views["lines"]]
        prev_views[gid] = g.get("views")
        views["kal"] = [[r[0], r[1], round(r[2], 4), round(r[3], 4), round(r[4], 4), round(r[5])] for r in list(kal.get(gid, {}).values())[:80]]
        g["views"] = views if views["lines"] else None
    weights = {(sid, sp): syn_weight(s, sp) for sid, s in syns.items() for sp in espn.SPORTS}
    syn_cap: dict[str, float] = {}
    for sid_ in syns:
        ms_ = [m for m in members.values() if m["syndicate_id"] == sid_]
        if any(m["params"].get("public") for m in ms_):
            syn_cap[sid_] = PUBLIC_CAP
            continue
        if any(m["params"].get("mm") for m in ms_):  # pure market makers aim to stay flat, so their risk is not a bet on a model
            syn_cap[sid_] = CAP_FULL
            continue
        n_ = sum(m["stats"].get("clv_n", 0) for m in ms_)
        if n_ < 40 or not any(m["stats"].get("clv_sq") for m in ms_):
            syn_cap[sid_] = CAP_BASE
            continue
        mean_ = sum(m["stats"]["clv_sum"] for m in ms_) / n_
        se_ = max(0.0, sum(m["stats"].get("clv_sq", 0.0) for m in ms_) / n_ - mean_**2) ** 0.5 / n_**0.5
        proof_ = float(np.clip((mean_ - 1.96 * se_) / 0.02, 0.0, 1.0))  # the low end of its CLV range, scaled so +2 cents sure earns the full limit
        syn_cap[sid_] = CAP_BASE + (CAP_FULL - CAP_BASE) * proof_
    syn_bonus: dict[tuple[str, str], float] = {}  # a syndicate gets more room in a sport where its best taker has proven sharp
    for m_ in members.values():
        for sp_, v_ in (m_["stats"].get("sharp") or {}).items():
            key_ = (m_["syndicate_id"], sp_)
            syn_bonus[key_] = max(syn_bonus.get(key_, 1.0), 1.0 + SPORT_BONUS * float(v_))
    for sid_, s_ in syns.items():
        s_["learn"] = s_.get("learn") or {}
        s_["learn"]["cap"] = round(syn_cap[sid_], 1)

    def fair(m: dict, k: str) -> float:
        mk = markets[k]
        sid = m["syndicate_id"]
        if m["params"].get("mm"):  # a market maker has no model: it blends the reference prices and lets order flow move it from there
            r, ks, pe = mk["ref"], (kal.get(mk["gid"], {}).get((mk["kind"], mk["line"])) if mk["src"] != "exchange" else None), prev_eco.get(k)
            f = 0.5 * r + 0.3 * ks[2] + 0.2 * pe if ks and pe is not None else 0.6 * r + 0.4 * ks[2] if ks else 0.8 * r + 0.2 * pe if pe is not None else r
            return clip(f, r - BAND, r + BAND)
        e = eng_p.get((sid, k), mk["ref"])
        w = float(np.clip(m["params"].get("trust", 1.0) * weights[(sid, mk["sport"])], W_FLOOR_EXCH if mk["src"] == "exchange" else 0.0, W_MAX))
        return clip(mk["ref"] + w * (e - mk["ref"]), mk["ref"] - BAND, mk["ref"] + BAND)

    # what each trader can look at: every sport, but outside its focus only the lines near the main number, smaller and pickier
    mine: dict[str, list[tuple[str, bool]]] = {}
    base_fairs: dict[tuple[str, str], float] = {}
    fairs: dict[tuple[str, str], float] = {}
    for m in members.values():
        kinds, focus = m["params"].get("kinds"), set(m["params"].get("focus", []))
        mine[m["id"]] = []
        for k, mk in markets.items():
            if kinds and mk["kind"] not in kinds:
                continue
            on = mk["sport"] in focus
            if on or mk["near"]:
                mine[m["id"]].append((k, on))
                base_fairs[(m["id"], k)] = fairs[(m["id"], k)] = fair(m, k)

    def sharp(mid: str, sport: str) -> float:
        """0 to 1: how much a trader's hits are worth listening to in a sport - its closing-line record as a taker, or its syndicate's proven model."""
        m = members[mid]
        if m["params"].get("public"):  # labelled public money: never treated as informed, however a lucky run looks
            return 0.0
        fl = (m["stats"].get("flow") or {}).get(sport)
        s1 = 0.0
        if fl and fl["w"] > 0:
            s1 = float(np.clip(fl["s"] / fl["w"] / SHARP_CLV, 0.0, 1.0)) * fl["w"] / (fl["w"] + SHARP_N)
        s2 = 0.7 * float(np.clip((weights[(m["syndicate_id"], sport)] - W0) / (W_MAX - W0), 0.0, 1.0))
        return max(s1, s2)

    # market moves caused by sharp flow: a shift in each game's expected margin and total that everyone who follows the flow adds to their fair prices
    flow: dict[str, list[float]] = {}
    mmb: dict[tuple[str, str], list[float]] = {}  # a market maker's own read of a game, built from who hit its quotes this round
    tox: dict[tuple[str, str], float] = {}  # recent one-sided fills on a contract: the maker quotes wider on it for a while
    delta: dict[str, float] = {}
    sd_of = {"nhl": (2.3, 2.4), **{sp: v[:2] for sp, v in pricing.SIGMA.items()}}

    def refresh(gid: str) -> None:
        dm, dt = flow.get(gid, [0.0, 0.0])
        d0 = refs[gid][0]
        d1 = Dist(d0.sport, d0.m + dm, d0.t + dt)
        for k in by_gid[gid]:
            mk = markets[k]
            delta[k] = d1.p(mk["kind"], mk["line"]) - d0.p(mk["kind"], mk["line"])
        for m in members.values():
            f = m["params"].get("follow", 0.5)
            bel = mmb.get((m["id"], gid)) if m["params"].get("mm") else None
            bd: dict[str, float] = {}
            if bel:
                db = Dist(d0.sport, d0.m + bel[0], d0.t + bel[1])
                bd = {k: db.p(markets[k]["kind"], markets[k]["line"]) - d0.p(markets[k]["kind"], markets[k]["line"]) for k in by_gid[gid]}
            for k in by_gid[gid]:
                if (m["id"], k) in base_fairs:
                    r = markets[k]["ref"]
                    fairs[(m["id"], k)] = clip(base_fairs[(m["id"], k)] + f * delta[k] + bd.get(k, 0.0), r - BAND, r + BAND)

    for gid in by_gid:
        pv = (prev_views.get(gid) or {}).get("flow")
        if pv and (abs(pv[0]) > 1e-6 or abs(pv[1]) > 1e-6):
            flow[gid] = [pv[0] * FLOW_DECAY, pv[1] * FLOW_DECAY]
            refresh(gid)

    # ---- positions: open lots by trader and game, with their worst-case risk
    lots_g: dict[tuple[str, str], list[dict]] = {}
    net: dict[tuple[str, str], float] = {}
    for t in sorted(open_trades, key=lambda t: (t["ts"], t["id"])):
        k = ckey(t["game_id"], t["kind"], t["line"])
        if t["rem_b"] > 1e-9:
            lots_g.setdefault((t["buyer"], t["game_id"]), []).append(t)
            net[(t["buyer"], k)] = net.get((t["buyer"], k), 0.0) + t["rem_b"]
        if t["rem_s"] > 1e-9:
            lots_g.setdefault((t["seller"], t["game_id"]), []).append(t)
            net[(t["seller"], k)] = net.get((t["seller"], k), 0.0) - t["rem_s"]
    pcache: dict[tuple[str, str], tuple] = {}
    tcache: dict[str, float] = {}
    games_of: dict[str, set] = {}
    for (mid, gid) in lots_g:
        games_of.setdefault(mid, set()).add(gid)

    def pos(mid: str, gid: str) -> tuple:
        c = pcache.get((mid, gid))
        if c is None:
            lots = []
            for t in lots_g.get((mid, gid), []):
                if t["buyer"] == mid and t["rem_b"] > 1e-9:
                    lots.append((t["kind"], t["line"], t["rem_b"], t["price"]))
                if t["seller"] == mid and t["rem_s"] > 1e-9:
                    lots.append((t["kind"], t["line"], -t["rem_s"], t["price"]))
            vm, vt = risk.position_vectors(grids[gid], lots)
            c = pcache[(mid, gid)] = (vm, vt, risk.worst(vm), risk.worst(vt))
        return c

    syn_members: dict[str, list[str]] = {}
    for m in members.values():
        syn_members.setdefault(m["syndicate_id"], []).append(m["id"])
    scache: dict[tuple[str, str], tuple] = {}

    def spos(sid: str, gid: str) -> tuple:
        """The syndicate's whole book on a game: its traders' positions added together (so one trader's long can offset another's short)."""
        c = scache.get((sid, gid))
        if c is None:
            vm, vt = np.zeros(len(grids[gid].mx)), np.zeros(len(grids[gid].tx))
            for mid in syn_members[sid]:
                if (mid, gid) in lots_g:
                    a, b, _, _ = pos(mid, gid)
                    vm, vt = vm + a, vt + b
            c = scache[(sid, gid)] = (vm, vt, risk.worst(vm), risk.worst(vt))
        return c

    def trisk(mid: str) -> float:
        v = tcache.get(mid)
        if v is None:
            v = tcache[mid] = sum(pos(mid, g)[2] + pos(mid, g)[3] for g in games_of.get(mid, ()))
        return v

    def total_limit(m: dict) -> float:
        return TOTAL_FRAC * (m["cash"] + m["locked"])

    def trust_of(sid: str, sport: str) -> float:
        return float(np.clip((weights[(sid, sport)] - 0.05) / 0.5, 0.0, 1.0))

    def patience(m: dict) -> float:
        """Idle traders loosen up: a trader that has not traded for a few rounds asks for a little less edge and quotes a little tighter, so the market keeps moving."""
        return 1.0 - PATIENCE_STEP * min(PATIENCE_MAX, m["stats"].get("idle", 0))

    def room_for(m: dict, mk: dict, side: str, px: float, soft: bool = False) -> float:
        """Contracts this trader can add on this side at this price before a game's worst case passes the per-game limit or its total
        worst case passes its share of the bankroll."""
        vm, vt, rm, rt = pos(m["id"], mk["gid"])
        u = (mk["ov"] - px) if side == "buy" else (px - mk["ov"])
        slack = max(0.0, total_limit(m) * (MAKER_SOFT if soft else 1.0) - trisk(m["id"]))
        bonus = 1.0 + SPORT_BONUS * float((m["stats"].get("sharp") or {}).get(mk["sport"], 0.0))
        lim = min(m["params"]["max_risk"] * bonus * mk["ramp"] * mk["srcf"], rm + rt + slack)
        q = risk.room(vm if mk["dim"] == "m" else vt, u, lim - (rt if mk["dim"] == "m" else rm))
        sm, st_, srm, srt = spos(m["syndicate_id"], mk["gid"])
        q2 = risk.room(sm if mk["dim"] == "m" else st_, u, syn_cap[m["syndicate_id"]] * syn_bonus.get((m["syndicate_id"], mk["sport"]), 1.0) * mk["ramp"] * mk["srcf"] - (srt if mk["dim"] == "m" else srm))
        return min(q, q2)

    def cash_room(m: dict, k: str, side: str, px: float) -> float:
        """Contracts it can trade on this side: closing what it holds needs no cash, opening needs the unit cost and keeps the reserve."""
        n = net.get((m["id"], k), 0.0)
        closing = max(0.0, -n) if side == "buy" else max(0.0, n)
        free = max(0.0, m["cash"] - RESERVE_FRAC * m["start_units"])
        return closing + free / (px if side == "buy" else 1 - px)

    prev_ts = _pdate(meta["round"]["ts"]) if meta.get("round") and meta["round"].get("ts") else now - timedelta(minutes=10)
    t0 = max(prev_ts, now - timedelta(minutes=30))
    clock = {"ts": _iso(now)}  # trades are stamped across the time since the last round, one slice per step
    modified: dict[str, dict] = {}
    new_trades: list[dict] = []
    last_px: dict[str, float] = {}
    first_px: dict[str, float] = {}
    bids: dict[str, list[list]] = {k: [] for k in markets}
    asks: dict[str, list[list]] = {k: [] for k in markets}

    def close_lots(m: dict, mk: dict, k: str, closing_long: bool, px: float, qty: float, role: str) -> float:
        """Net a new trade against what the trader already holds the other way, first in first out; returns how much was closed."""
        left, done = qty, 0.0
        for t in lots_g.get((m["id"], mk["gid"]), []):
            if left < 1e-9:
                break
            if t["kind"] != mk["kind"] or t["line"] != mk["line"]:
                continue
            if closing_long and t["buyer"] == m["id"] and t["rem_b"] > 1e-9:  # selling out of a long
                u = min(t["rem_b"], left)
                pnl, release = u * (px - t["price"]), u * t["price"]
                t["rem_b"] -= u
            elif not closing_long and t["seller"] == m["id"] and t["rem_s"] > 1e-9:  # buying back a short
                u = min(t["rem_s"], left)
                pnl, release = u * (t["price"] - px), u * (1 - t["price"])
                t["rem_s"] -= u
            else:
                continue
            m["cash"] += release + pnl
            m["locked"] -= release
            m["realized"] += pnl
            m["stats"][f"pnl_{role}"] += pnl
            modified[t["id"]] = t
            left -= u
            done += u
        return done

    def fill(buyer: dict, seller: dict, maker: dict, mk: dict, k: str, px: float, qty: float) -> dict:
        cb = close_lots(buyer, mk, k, False, px, qty, "maker" if buyer is maker else "taker")
        cs = close_lots(seller, mk, k, True, px, qty, "maker" if seller is maker else "taker")
        tr = {"id": f"r{rnd}-{len(new_trades)}", "ts": clock["ts"], "round": rnd, "game_id": mk["gid"], "kind": mk["kind"], "line": mk["line"],
              "price": px, "qty": qty, "buyer": buyer["id"], "seller": seller["id"], "maker": maker["id"], "ref_p": round(mk["ref"], 4),
              "rem_b": round(qty - cb, 6), "rem_s": round(qty - cs, 6), "settled": False, "outcome": None, "close_p": None}
        new_trades.append(tr)
        buyer["cash"] -= tr["rem_b"] * px
        buyer["locked"] += tr["rem_b"] * px
        seller["cash"] -= tr["rem_s"] * (1 - px)
        seller["locked"] += tr["rem_s"] * (1 - px)
        for who, side_qty in ((buyer, qty), (seller, -qty)):
            role = "maker" if who is maker else "taker"
            who["stats"][f"n_{role}"] += 1
            who["stats"][f"vol_{role}"] += qty * (px if who is buyer else 1 - px)
            net[(who["id"], k)] = net.get((who["id"], k), 0.0) + side_qty
            pcache.pop((who["id"], mk["gid"]), None)
            dcache.pop((who["id"], mk["gid"]), None)
            pdcache.pop((who["id"], mk["gid"]), None)
            scache.pop((who["syndicate_id"], mk["gid"]), None)
            tcache.pop(who["id"], None)
            games_of.setdefault(who["id"], set()).add(mk["gid"])
        if tr["rem_b"] > 1e-9:
            lots_g.setdefault((buyer["id"], mk["gid"]), []).append(tr)
        if tr["rem_s"] > 1e-9:
            lots_g.setdefault((seller["id"], mk["gid"]), []).append(tr)
        last_px[k] = px
        first_px.setdefault(k, px)
        taker = buyer if maker is seller else seller
        cap = (px - mk["ref"]) if maker is seller else (mk["ref"] - px)  # what the maker earned against DraftKings at the moment of the fill
        ms = maker["stats"]
        ms["cap_sum"], ms["cap_q"] = ms.get("cap_sum", 0.0) + qty * cap, ms.get("cap_q", 0.0) + qty
        if maker["params"].get("mm"):  # a market maker learns from who hit it: the game is probably a little further their way
            sd_m, sd_t = sd_of[mk["sport"]]
            imp = (1.0 if taker is buyer else -1.0) * MM_REACT * maker["params"].get("eta", 1.0) * IMPACT * (PUBLIC_REACT if taker["params"].get("public") else 0.5 + sharp(taker["id"], mk["sport"])) * min(1.0, qty / IMPACT_Q)
            b = mmb.setdefault((maker["id"], mk["gid"]), [0.0, 0.0])
            if mk["kind"] == "total":
                b[1] = float(np.clip(b[1] + imp * sd_t, -0.25 * sd_t, 0.25 * sd_t))
            else:
                b[0] = float(np.clip(b[0] + imp * sd_m, -0.25 * sd_m, 0.25 * sd_m))
            tox[(maker["id"], k)] = tox.get((maker["id"], k), 0.0) + (0.2 if taker["params"].get("public") else 1.0)
            refresh(mk["gid"])
        sh = sharp(taker["id"], mk["sport"])
        if sh > 0.02:  # a trader with a record hit this: everyone following the flow marks the game a little their way
            sd_m, sd_t = sd_of[mk["sport"]]
            imp = (1.0 if taker is buyer else -1.0) * sh * IMPACT * min(1.0, qty / IMPACT_Q)
            f = flow.setdefault(mk["gid"], [0.0, 0.0])
            if mk["kind"] == "total":
                f[1] = float(np.clip(f[1] + imp * sd_t, -0.2 * sd_t, 0.2 * sd_t))
            else:
                f[0] = float(np.clip(f[0] + imp * sd_m, -0.2 * sd_m, 0.2 * sd_m))
            refresh(mk["gid"])
        return tr

    sens_cache: dict[tuple[str, str, float], float] = {}

    def sens_of(gid: str, kind: str, line: float) -> float:
        """How much a contract's price moves per point the game's expected margin (or total) moves."""
        key = (gid, kind, line)
        v = sens_cache.get(key)
        if v is None:
            d0 = refs[gid][0]
            up, dn = (Dist(d0.sport, d0.m, d0.t + 0.5), Dist(d0.sport, d0.m, d0.t - 0.5)) if kind == "total" else (Dist(d0.sport, d0.m + 0.5, d0.t), Dist(d0.sport, d0.m - 0.5, d0.t))
            v = sens_cache[key] = up.p(kind, line) - dn.p(kind, line)
        return v

    smax_cache: dict[tuple[str, str], float] = {}

    def smax(gid: str, dim: str) -> float:
        key = (gid, dim)
        v = smax_cache.get(key)
        if v is None:
            v = smax_cache[key] = max([abs(sens_of(gid, markets[k]["kind"], markets[k]["line"])) for k in by_gid[gid] if markets[k]["dim"] == dim] + [1e-6])
        return v

    dcache: dict[tuple[str, str], tuple[float, float]] = {}

    def delta_exp(mid: str, gid: str) -> tuple[float, float]:
        """A trader's position on a game as probability change per point of margin and per point of total: flat when long and short offset across lines."""
        c = dcache.get((mid, gid))
        if c is None:
            dm = dt = 0.0
            for t in lots_g.get((mid, gid), []):
                q = (t["rem_b"] if t["buyer"] == mid else 0.0) - (t["rem_s"] if t["seller"] == mid else 0.0)
                s = sens_of(gid, t["kind"], t["line"]) * q
                if t["kind"] == "total":
                    dt += s
                else:
                    dm += s
            c = dcache[(mid, gid)] = (dm, dt)
        return c

    pdcache: dict[tuple[str, str], tuple[float, float]] = {}

    def delta_pub(mid: str, gid: str) -> tuple[float, float]:
        """The part of a maker's position on a game (in the same units as delta_exp) that it took from public bettors."""
        c = pdcache.get((mid, gid))
        if c is None:
            dm = dt = 0.0
            for t in lots_g.get((mid, gid), []):
                if t["maker"] != mid:
                    continue
                other = t["seller"] if t["buyer"] == mid else t["buyer"]
                if not members[other]["params"].get("public"):
                    continue
                q = t["rem_b"] if t["buyer"] == mid else -t["rem_s"]
                s = sens_of(gid, t["kind"], t["line"]) * q
                if t["kind"] == "total":
                    dt += s
                else:
                    dm += s
            c = pdcache[(mid, gid)] = (dm, dt)
        return c

    def relief(own: float, pub: float) -> float:
        return SQ_TOL * float(np.sign(own)) * min(abs(own), abs(pub)) if own * pub > 0 else 0.0

    def post_quotes(m: dict) -> None:
        """Cancel and re-post this trader's quotes: a bid and an ask either side of its fair price, leaned away from any position it holds.
        Each side is sized on its own against the risk limits, so a one-sided fill can never push a maker past them."""
        p = m["params"]
        taper = max(0.0, 1 - trisk(m["id"]) / max(1e-9, total_limit(m) * MAKER_SOFT))
        mm = bool(p.get("mm"))
        tmult = 1.0
        if mm:  # widen when the maker's own fills have been closing against it, tighten when they have been harmless
            n_ = m["stats"].get("clv_maker_n", 0)
            avg_ = m["stats"].get("clv_maker_sum", 0.0) / n_ if n_ >= 20 else 0.0
            tmult = 1.0 + p.get("tox", 1.0) * float(np.clip(-avg_ / 0.02, 0.0, 1.5)) if avg_ < 0 else (0.85 if avg_ > 0.01 else 1.0)
        for k, on in mine[m["id"]]:
            bids[k] = [q for q in bids[k] if q[2] != m["id"]]
            asks[k] = [q for q in asks[k] if q[2] != m["id"]]
            mk = markets[k]
            if mm:  # lean against the whole book on the game, not just this line, and quote wider where it has just been hit
                dm_, dt_ = delta_exp(m["id"], mk["gid"])
                pm_, pt_ = delta_pub(m["id"], mk["gid"])  # inventory taken from public bettors is not a signal, so it is leaned against less
                dm_, dt_ = dm_ - relief(dm_, pm_), dt_ - relief(dt_, pt_)
                s0 = smax(mk["gid"], mk["dim"])
                inv = (dm_ if mk["dim"] == "m" else dt_) / max(1e-9, p["size"] * s0) * (sens_of(mk["gid"], mk["kind"], mk["line"]) / s0)
                c = fairs[(m["id"], k)] - 2.0 * p["half"] * p.get("inv", 1.0) * inv
                half = max(RULES["half_min"], p["half"] * patience(m)) * tmult * (1.3 if mk["hrs"] < 1 else 1.0) + 0.004 * tox.get((m["id"], k), 0.0)
            else:
                c = fairs[(m["id"], k)] - 2.0 * p["half"] * net.get((m["id"], k), 0.0) / max(1.0, p["size"])  # a full-size position moves both quotes two half-spreads
                half = max(RULES["half_min"], p["half"] * patience(m))
            bid, ask = max(0.01, float(np.floor((c - half) * 100) / 100)), min(0.99, float(np.ceil((c + half) * 100) / 100))
            if bid >= ask:
                continue
            size = p["size"] * taper * (1.0 if on else 0.5) * max(0.3, mk["ramp"])
            qb = min(size, room_for(m, mk, "buy", bid, True), cash_room(m, k, "buy", bid))
            qa = min(size, room_for(m, mk, "sell", ask, True), cash_room(m, k, "sell", ask))
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
        cands = []
        for k, on in mine[m["id"]]:
            thr = max(RULES["thr_min"], (p["thr"] + (0.0 if on else 0.01) + UNPROVEN_EDGE * (1.0 - trust_of(m["syndicate_id"], markets[k]["sport"]))) * patience(m))
            pf = fairs[(m["id"], k)]
            a, b = best(asks[k], m["id"]), best(bids[k], m["id"])
            if a and pf - a[0] >= thr:
                cands.append((pf - a[0], k, "buy", pf, thr, on))
            elif b and b[0] - pf >= thr:
                cands.append((b[0] - pf, k, "sell", pf, thr, on))
        cands.sort(reverse=True)
        fills = 0
        for edge, k, side, pf, thr, on in cands:
            if fills >= MAX_FILLS:
                break
            book = asks[k] if side == "buy" else bids[k]
            mk = markets[k]
            for _ in range(6):  # walk the book while it still pays
                if fills >= MAX_FILLS:
                    break
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
                trust = trust_of(m["syndicate_id"], mk["sport"])
                kelly_q = p["kelly"] * f * bankroll / unit * (1.0 if on else 0.5) * (UNPROVEN_SIZE + (1.0 - UNPROVEN_SIZE) * trust)
                maker = members[q[2]]
                m_side = "sell" if side == "buy" else "buy"
                qty = min(kelly_q, TAKE_CLIP, q[1], room_for(m, mk, side, px), cash_room(m, k, side, px),
                          room_for(maker, mk, m_side, px, True), cash_room(maker, k, m_side, px))
                qty = round(qty, 2)
                if qty < 1:
                    if q[1] > 0.5 and min(room_for(maker, mk, m_side, px, True), cash_room(maker, k, m_side, px)) < 1:
                        q[1] = 0  # the maker has no room left at that price
                        continue
                    break
                buyer, seller = (m, maker) if side == "buy" else (maker, m)
                fill(buyer, seller, maker, mk, k, px, qty)
                fills += 1
                q[1] = round(q[1] - qty, 2)

    # ---- public money: bets arrive at random, favour favourites, overs and underdog moneylines, and cluster in the last few hours before a game
    nprng = np.random.default_rng(rnd * 7919 + 13)
    game_w: dict[str, float] = {}

    def pub_time(hrs: float) -> float:
        return 0.0 if hrs < 0 else 1.8 if hrs < 1 else 1.0 if hrs < 3 else 0.5 if hrs < 6 else 0.2 if hrs < 12 else 0.08 if hrs < 24 else 0.03 if hrs < 48 else 0.01

    def gw(gid: str) -> float:
        v = game_w.get(gid)
        if v is None:
            st_ = _pdate(games[gid]["start_utc"])
            v = pub_time((st_ - now).total_seconds() / 3600)
            et_ = st_.astimezone(results.ET)
            v *= (1.25 if et_.weekday() >= 5 else 1.0) * (1.2 if 19 <= et_.hour <= 23 else 1.0)  # weekends and primetime draw more
            game_w[gid] = v
        return v

    pub_book: dict[str, tuple[list, np.ndarray]] = {}

    def pub_weights(m: dict) -> tuple[list, np.ndarray]:
        style = m["params"]["style"]
        fav_sport = list(espn.SPORTS)[sum(map(ord, m["id"])) % len(espn.SPORTS)]
        keys: list[tuple[str, str]] = []
        ws: list[float] = []
        for k, mk in markets.items():
            gid = mk["gid"]
            w0 = gw(gid)
            if w0 <= 0:
                continue
            d0, ml0 = refs[gid]
            ph = ml0 if ml0 is not None else d0.p_ml()
            od = refos.get(gid)
            sd_m, sd_t = sd_of[mk["sport"]]
            kind = mk["kind"]
            near = 1.0 if mk["near"] else 0.25
            for side in ("buy", "sell"):
                yes = side == "buy"
                if kind == "total":
                    over, fav, dog_ml, team_side = yes, False, False, False
                    p_team = 0.5
                else:
                    team_side = yes  # buying "yes" is the home team, selling it is the away team
                    p_team = ph if yes else 1 - ph
                    over, fav, dog_ml = False, p_team > 0.5, kind == "ml" and p_team < 0.4
                if style == "chalk":
                    a = 1.2 * fav + 1.0 * over
                elif style == "lottery":
                    a = 1.6 * dog_ml + 0.6 * over + 0.4 * (kind == "spread" and not fav)
                elif style == "hot":
                    hs = eng_p.get(("form", k), mk["ref"]) - eng_p.get(("ridge", k), mk["ref"])
                    a = 25.0 * (hs if yes else -hs)
                elif style == "model":
                    adj = eng_p.get(("blend", k), mk["ref"]) - mk["ref"]
                    a = 40.0 * (adj if yes else -adj)
                elif style == "homer":
                    a = 1.0 * (kind != "total" and yes) + 0.8 * (mk["sport"] == fav_sport)
                elif style == "drift":
                    if od is None:
                        a = 0.0
                    elif kind == "total":
                        a = 1.2 * float(np.clip((d0.t - od.t) / sd_t, -1, 1)) * (1 if yes else -1)
                    else:
                        a = 1.2 * float(np.clip((d0.m - od.m) / sd_m, -1, 1)) * (1 if yes else -1)
                else:  # casual
                    a = 0.5 * fav + 0.5 * over
                keys.append((k, side))
                ws.append(w0 * near * float(np.exp(np.clip(a, -3.0, 3.0))))
        w = np.array(ws)
        return keys, (w / w.sum() if len(ws) and w.sum() > 0 else w)

    def public_take(m: dict) -> None:
        p = m["params"]
        if m["id"] not in pub_book:
            pub_book[m["id"]] = pub_weights(m)
        keys, w = pub_book[m["id"]]
        if not keys:
            return
        tw_total = sum(gw(g) for g in by_gid)
        n = min(PUBLIC_MAX, int(nprng.poisson(max(PUBLIC_FLOOR, p["act"] * PUBLIC_RATE * tw_total))))
        for _ in range(n):
            k, side = keys[int(nprng.choice(len(keys), p=w))]
            mk = markets[k]
            q = best(asks[k] if side == "buy" else bids[k], m["id"])
            if not q:
                continue
            px = q[0]
            pf = mk["ref"] + (0.2 * (eng_p.get(("blend", k), mk["ref"]) - mk["ref"]) if p["style"] == "model" else 0.0)
            if (side == "buy" and px > pf + p["tol"]) or (side == "sell" and px < pf - p["tol"]):  # a recreational bettor will pay a few cents over fair, not a terrible price
                continue
            maker = members[q[2]]
            m_side = "sell" if side == "buy" else "buy"
            qty = round(min(float(nprng.integers(3, 16)) * p["sizem"], q[1], room_for(m, mk, side, px), cash_room(m, k, side, px),
                            room_for(maker, mk, m_side, px, True), cash_room(maker, k, m_side, px)), 2)
            if qty < 1:
                if q[1] > 0.5 and min(room_for(maker, mk, m_side, px, True), cash_room(maker, k, m_side, px)) < 1:
                    q[1] = 0
                continue
            buyer, seller = (m, maker) if side == "buy" else (maker, m)
            fill(buyer, seller, maker, mk, k, px, qty)
            q[1] = round(q[1] - qty, 2)

    # ---- time flows: traders arrive in random order over a number of ticks, refresh their quotes, and hit each other's
    order = list(members.values())
    rng.shuffle(order)
    for m in order:
        if m["role"] in ("maker", "both") and not m["params"].get("public"):  # public money only ever takes, never rests a quote
            post_quotes(m)
    for tick in range(ticks):
        clock["ts"] = _iso(t0 + (now - t0) * ((tick + 1) / (ticks + 1)))
        rng.shuffle(order)
        if tick > 0 and (mmb or tox):  # between steps a market maker's read of a game relaxes back toward the reference prices
            for key in list(mmb):
                mmb[key] = [x * 0.93 for x in mmb[key]]
            for key in list(tox):
                tox[key] *= 0.8
            for gid in {g for (_, g) in mmb}:
                refresh(gid)
        for m in order:
            if m["params"].get("public"):
                public_take(m)
                continue
            if tick > 0 and rng.random() > ACT_PROB:
                continue
            if tick > 0 and m["role"] in ("maker", "both") and not m["params"].get("public"):
                post_quotes(m)
            if m["role"] in ("taker", "both"):
                take(m)
    open_all = open_trades + new_trades

    # ---- the exchange's own price for each contract: size-weighted mid of the best bid and ask, else the last trade
    eco: dict[str, float | None] = {}
    two_sided: dict[str, float] = {}  # prices backed by both a bid and an ask: the only ones allowed to move a self-made line
    for k in markets:
        b, a = (bids[k][0] if bids[k] else None), (asks[k][0] if asks[k] else None)
        eco[k] = round((b[0] * a[1] + a[0] * b[1]) / (a[1] + b[1]), 4) if b and a and a[1] + b[1] > 0 else last_px.get(k)
        if b and a and a[1] + b[1] > 0:
            two_sided[k] = eco[k]
    for gid, g in games.items():
        v = g.get("views")
        if not v or gid not in by_gid:
            continue
        v["x"] = [eco.get(ckey(gid, kd, ln)) for kd, ln in v["lines"]]
        if gid in flow and (abs(flow[gid][0]) > 1e-6 or abs(flow[gid][1]) > 1e-6):
            v["flow"] = [round(flow[gid][0], 4), round(flow[gid][1], 4)]
        old = prev_views.get(gid)
        prior = (old or {}).get("x") or [None] * len(v["x"])
        moved = (not old or old.get("r") != v["r"] or old.get("lines") != v["lines"]
                 or any((a is None) != (b is None) or (a is not None and abs(a - b) >= 0.005) for a, b in zip(v["x"], prior)))
        if moved:
            marks.append({"ts": _iso(now), "game_id": gid, "lines": v["lines"], "r": v["r"], "e": v["x"]})

    # ---- the exchange's own lines move toward the prices its traders actually reached
    for gid, g in games.items():
        r = g.get("ref")
        if not r or r.get("src") != "exchange" or gid not in by_gid:
            continue
        ks_ = [k for k in by_gid[gid] if k in two_sided]
        sp_pts = [(markets[k]["line"], two_sided[k]) for k in ks_ if markets[k]["kind"] == "spread"]
        tt_pts = [(markets[k]["line"], two_sided[k]) for k in ks_ if markets[k]["kind"] == "total"]
        ml_pt = next((two_sided[k] for k in ks_ if markets[k]["kind"] == "ml"), None)
        if len(sp_pts) < 2 and len(tt_pts) < 2:
            continue
        ef = pricing.fit_from_probs(g["sport"], sp_pts, tt_pts, ml_pt)
        if not ef:
            continue
        sdm, sdt = sd_of[g["sport"]]
        seed = r.get("seed") or r["mt"]
        m1 = r["mt"][0] + float(np.clip(CENTER_ETA * (ef[0] - r["mt"][0]), -CENTER_STEP * sdm, CENTER_STEP * sdm)) if len(sp_pts) >= 2 or ml_pt is not None else r["mt"][0]
        t1 = r["mt"][1] + float(np.clip(CENTER_ETA * (ef[1] - r["mt"][1]), -CENTER_STEP * sdt, CENTER_STEP * sdt)) if len(tt_pts) >= 2 else r["mt"][1]
        m1 = float(np.clip(m1, seed[0] - CENTER_DRIFT * sdm, seed[0] + CENTER_DRIFT * sdm))
        t1 = float(np.clip(t1, seed[1] - CENTER_DRIFT * sdt, seed[1] + CENTER_DRIFT * sdt))
        snap = pricing.synth_snap(g["sport"], m1, t1)
        snap.update(src="exchange", mt=[round(m1, 3), round(t1, 3)], seed=seed, rounds=int(r.get("rounds", 0)) + 1)
        g["ref"] = snap

    # ---- mark to market
    unreal: dict[str, float] = {}
    for t in open_all:
        pr_ = p_ref(t["game_id"], t["kind"], t["line"])
        if pr_ is not None:
            unreal[t["buyer"]] = unreal.get(t["buyer"], 0.0) + t["rem_b"] * (pr_ - t["price"])
            unreal[t["seller"]] = unreal.get(t["seller"], 0.0) + t["rem_s"] * (t["price"] - pr_)
    snaps = []
    for m in members.values():
        eq = m["cash"] + m["locked"] + unreal.get(m["id"], 0.0)
        m["equity"], m["open_risk"], m["updated_at"] = round(eq, 3), round(trisk(m["id"]), 3), _iso(now)
        st = m["stats"]
        st["peak"] = max(st["peak"], eq)
        st["max_dd"] = max(st["max_dd"], st["peak"] - eq)
        if rnd % SNAP_EVERY == 0:
            snaps.append({"ts": _iso(now), "subject": f"mem:{m['id']}", "equity": m["equity"], "realized": round(m["realized"], 3), "open_risk": m["open_risk"]})
    for sid, s in syns.items():
        s["learn"] = s.get("learn") or {}
        s["learn"]["w"] = {sp: round(weights[(sid, sp)], 3) for sp in espn.SPORTS}
        if rnd % SNAP_EVERY == 0:
            snaps += [{"ts": _iso(now), "subject": f"w:{sid}:{sp}", "equity": round(weights[(sid, sp)], 4), "realized": None, "open_risk": None} for sp in espn.SPORTS]
            ms = [m for m in members.values() if m["syndicate_id"] == sid]
            snaps.append({"ts": _iso(now), "subject": f"syn:{sid}", "equity": round(sum(m["equity"] for m in ms), 3),
                          "realized": round(sum(m["realized"] for m in ms), 3), "open_risk": round(sum(m["open_risk"] for m in ms), 3)})
    for m in members.values():
        adapt(m, _iso(now))
        m["stats"]["sharp"] = {sp: round(sharp(m["id"], sp), 3) for sp in espn.SPORTS}

    # ---- the book the page shows: [kind, line, fair, best bid, best ask, last trade, first trade this round, bid size, ask size, exchange price, [bid levels, ask levels]]
    def levels(book: list[list]) -> list[list]:
        agg: dict[float, list] = {}
        for q in book:
            if q[1] > 0.5:
                a = agg.setdefault(q[0], [0.0, 0.0, ""])
                a[0] += q[1]
                if q[1] > a[1]:
                    a[1], a[2] = q[1], q[2]
        return [[p, round(v[0]), v[2]] for p, v in list(agg.items())[:5]]

    by_game: dict[str, list] = {}
    for k, mk in markets.items():
        b, a = (bids[k][0] if bids[k] else None), (asks[k][0] if asks[k] else None)
        by_game.setdefault(mk["gid"], []).append([mk["kind"], mk["line"], round(mk["ref"], 3), b and b[0], a and a[0], last_px.get(k), first_px.get(k),
                                                  b and b[1], a and a[1], eco.get(k), [levels(bids[k]), levels(asks[k])]])
    for gid, rows in by_game.items():
        games[gid]["book"] = rows

    # ---- who traded this round (the idle ones loosen up next round)
    active_ = {x for t in new_trades for x in (t["buyer"], t["seller"])}
    for m_ in members.values():
        m_["stats"]["idle"] = 0 if m_["id"] in active_ else min(PATIENCE_MAX + 4, m_["stats"].get("idle", 0) + 1)

    # ---- write back
    store.upsert("ex_games", list(games.values()))
    if new_trades:
        store.insert("ex_trades", new_trades)
    new_ids = {t["id"] for t in new_trades}
    changed = [t for tid, t in modified.items() if tid not in new_ids] + settled_rows
    if changed:
        store.upsert("ex_trades", list({t["id"]: t for t in changed}.values()))
    store.upsert("ex_members", list(members.values()))
    store.upsert("ex_syndicates", list(syns.values()))
    if discoveries:
        old_rows = (meta.get("discovery") or {}).get("rows", [])
        store.upsert("ex_meta", [{"key": "discovery", "value": {"rows": (discoveries + old_rows)[:300]}}])
    try:  # the historical tables are optional: a round must never fail because they are missing or slow
        if result_rows:
            try:
                store.upsert("ex_results", result_rows)
            except Exception:  # the closing-price column may not exist yet: keep the results without it
                store.upsert("ex_results", [{k: v for k, v in r.items() if k != "closing"} for r in result_rows])
        results.maybe_digest(store, meta, syns, members, now)
    except Exception as e:
        print(f"  (history skipped: {str(e)[:120]})", flush=True)
    if snaps:
        store.insert("ex_snapshots", snaps)
    if marks:
        store.insert("ex_marks", marks)
    store.upsert("ex_meta", [{"key": "round", "value": {"n": rnd, "ts": _iso(now), "markets": len(markets), "games": len(by_gid),
                                                         "new_trades": len(new_trades), "settled": stats["settled"], "ticks": ticks,
                                                         "secs": round(time.time() - t_start, 1), "errors": [s["id"] for s in syns.values() if ((s.get("learn") or {}).get("agent") or {}).get("error")]}}])
    store.save()
    out = {"round": rnd, "games_new": n_new, "games_listed": len(by_gid), "markets": len(markets), "new_trades": len(new_trades), **stats,
           "learned": n_learned, "open": len(open_all)}
    if verbose:
        print(out, flush=True)
    return out
