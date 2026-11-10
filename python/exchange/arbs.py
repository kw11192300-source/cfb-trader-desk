"""Arbitrage log: every round, find the DraftKings-against-Kalshi arbs that are open, and keep a record of each one from the round it appeared to the round it closed.

An arb is a bet at DraftKings' actual price (vig included) on one side of a main line, plus the opposite side bought on Kalshi at its ask, on the same line, where the two cost less than $1 together: one of the two pays $1
whatever happens. DraftKings' prices come from ESPN's feed and can lag, so a logged arb is "open on the prices we can see", and the log keeps both its gross cost and its cost after Kalshi's taker fee (about 7% x p x (1 - p) per
contract, which is why almost none of them are worth taking).

State lives in two ex_meta keys: "arbs" ({"since", "rounds", "open": {key: record}}, small, written every round) and "arbs_closed" (a list of the latest CLOSED_KEEP closed records, written only when one closes). A record keeps the best (lowest-cost) look it ever got, its size in Kalshi contracts at that
price (each contract pays $1), when it first and last appeared, and when it closed and why. Rounds are about five minutes apart, so an arb that came and went inside one round is never seen and every lifetime is good to about
one round.  The Kalshi tab shows it; run it by hand with python -m exchange.arbs to print what is open.

Betting only the DraftKings side: an arb means Kalshi prices the other side so low that the DraftKings side is worth more than DraftKings charges for it. So each record also keeps the DraftKings bet at the price
it first had when the arb appeared (dk_am0, one unit staked, no hedge on Kalshi). Its closing-line value is filled in when the game starts, in points (clv_pts) and, on an unmoved line, cents (clv), and the result
(res, pnl in units) when the game is final. That is the record of the idea "when Kalshi disagrees with DraftKings this way, take DraftKings' side"."""
from __future__ import annotations

from datetime import datetime, timezone

CLOSED_KEEP = 600
FEE_RATE = 0.07  # Kalshi's taker fee per contract is about this x p x (1 - p), in dollars
VIG_MIN, VIG_MAX = 1.01, 1.12  # a DraftKings two-way price outside this is stale or one-sided, not a quote


def implied(a: float) -> float:
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def american(p: float) -> int:
    return round(100 * (1 - p) / p) if p < 0.5 else round(-100 * p / (1 - p))


def profit_units(am: float) -> float:
    """Profit on a winning one-unit bet at these American odds."""
    return am / 100 if am > 0 else 100 / abs(am)


def _sg(x: float) -> str:
    return f"+{x:g}" if x > 0 else f"{x:g}"


def find(g: dict, rows: list[list]) -> list[dict]:
    """The arbs open on one game right now, from its DraftKings reference line and Kalshi's rows [kind, line, mid, bid, ask, volume, bid size, ask size]."""
    ref = g.get("ref") or {}
    if g.get("state") != "pre" or ref.get("src", "dk") != "dk":
        return []
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    out = []
    for r in rows:
        kind, line, bid, ask = r[0], r[1], r[3], r[4]
        vol = r[5] if len(r) > 5 else 0
        bs = r[6] if len(r) > 6 else None
        asz = r[7] if len(r) > 7 else None
        if bid is None or ask is None:
            continue
        if kind == "ml":
            dh, da, lh, la = ref.get("ml_home"), ref.get("ml_away"), f"{h} to win", f"{a} to win"
        elif kind == "spread":
            if ref.get("spread") is None or abs(line - ref["spread"]) > 1e-6:
                continue
            dh, da, lh, la = ref.get("spread_home"), ref.get("spread_away"), f"{h} {_sg(line)}", f"{a} {_sg(-line)}"
        else:
            if ref.get("total") is None or abs(line - ref["total"]) > 1e-6:
                continue
            dh, da, lh, la = ref.get("over"), ref.get("under"), f"Over {line:g}", f"Under {line:g}"
        if dh is None or da is None:
            continue
        ph, pa = implied(dh), implied(da)
        if not (VIG_MIN < ph + pa < VIG_MAX):
            continue
        # side A: DraftKings home/over and Kalshi's other side at 1 - bid; side B: DraftKings away/under and Kalshi yes at its ask
        for side, dk_p, dk_am, dk_lab, k_lab, kp, size in (("A", ph, dh, lh, la, 1 - bid, bs), ("B", pa, da, la, lh, ask, asz)):
            cost = dk_p + kp
            if cost >= 1 - 1e-9:
                continue
            out.append({"key": f"{g['id']}|{kind}|{line:g}|{side}", "gid": g["id"], "sport": g["sport"], "teams": f"{a} @ {h}", "start": g["start_utc"], "kind": kind, "line": line, "side": side,
                        "dk_label": dk_lab, "dk_am": dk_am, "dk_opp": da if side == "A" else dh, "nv": round(dk_p / (ph + pa), 4), "k_label": k_lab, "kp": round(kp, 4), "cost": round(cost, 4), "fee": round(FEE_RATE * kp * (1 - kp), 4),
                        "size": None if size is None else int(size), "vol": int(vol or 0), "width": round(ask - bid, 4)})
    return out


def _gone_why(g: dict | None, rec: dict, rows: list[list], now: datetime) -> str:
    """Why an arb that was open last round is not any more, from what DraftKings and Kalshi show now."""
    if g is None or g.get("state") != "pre":
        return "game started"
    try:
        if datetime.fromisoformat(g["start_utc"].replace("Z", "+00:00")) <= now:
            return "game started"
    except ValueError:
        pass
    ref = g.get("ref") or {}
    kind, line = rec["kind"], rec["line"]
    if kind == "ml":
        now_am = ref.get("ml_home") if rec["side"] == "A" else ref.get("ml_away")
    elif kind == "spread":
        if ref.get("spread") is None or abs(line - ref["spread"]) > 1e-6:
            return "DraftKings moved the line"
        now_am = ref.get("spread_home") if rec["side"] == "A" else ref.get("spread_away")
    else:
        if ref.get("total") is None or abs(line - ref["total"]) > 1e-6:
            return "DraftKings moved the line"
        now_am = ref.get("over") if rec["side"] == "A" else ref.get("under")
    if now_am is None:
        return "DraftKings stopped pricing it"
    if abs(now_am - rec["dk_am"]) > 1e-6:
        return "DraftKings moved the price"
    row = next((r for r in rows if r[0] == kind and abs(r[1] - line) < 1e-6), None)
    if row is None:
        return "Kalshi stopped quoting it"
    return "Kalshi moved its price"


def _implied_value(kind: str, sport: str, line: float, p_yes: float) -> float | None:
    """What a no-vig price at a line says the game's total (or home margin) is: the number whose fair price at that line is p_yes. This is what lets a closing price at the SAME line and a closing line that MOVED be
    compared in points. Moneylines and hockey totals (no normal model) have none."""
    from scipy.special import ndtri

    from .pricing import SIGMA

    if sport not in SIGMA or kind == "ml" or not (0.02 < p_yes < 0.98):
        return None
    if kind == "total":
        return line + SIGMA[sport][1] * float(ndtri(p_yes))
    return -line + SIGMA[sport][0] * float(ndtri(p_yes))  # home covers a spread of `line` when the home margin beats -line


def grade(rec: dict, g: dict | None) -> bool:
    """Work out what a closed record's DraftKings-only bet turned into, as the game gets there. Returns True when anything was added this call.

    Closing-line value is filled in as soon as the game has started (DraftKings' line stops updating then, so its stored line is the close), without waiting for the result:
      clv_pts  how far the close moved toward the bet in points of the game's total or margin (+1 = the number moved one point your way). It counts both a moved line (an Over bought at 53.5 that closes at 54.5)
               and a moved price at the same line (turned into points through the sport's spread of results). Spreads and totals only.
      clv      the move in DraftKings' no-vig probability on the bet's side, in cents, where the line did not move.
    The result is added when the game is final: res (1 win, 0 loss, 0.5 push) and pnl in units at the odds when the arb appeared."""
    if g is None or g.get("voided"):
        return False
    changed = False
    ref = g.get("ref") or {}
    kind, line, side = rec["kind"], rec["line"], rec["side"]
    if g.get("state") != "pre" and not rec.get("clv_done"):
        pair, cl_line = None, line
        if kind == "ml":
            pair = (ref.get("ml_home"), ref.get("ml_away"))
        elif kind == "spread" and ref.get("spread") is not None:
            pair, cl_line = (ref.get("spread_home"), ref.get("spread_away")), ref["spread"]
        elif kind == "total" and ref.get("total") is not None:
            pair, cl_line = (ref.get("over"), ref.get("under")), ref["total"]
        rec["close_nv"] = rec["clv"] = rec["clv_pts"] = rec["close_line"] = None
        if pair and pair[0] is not None and pair[1] is not None:
            ph, pa = implied(pair[0]), implied(pair[1])
            yes_close = ph / (ph + pa)  # home covers / over / home wins at the closing line
            nv_close = yes_close if side == "A" else 1 - yes_close
            rec["close_line"] = cl_line
            if abs(cl_line - line) < 1e-6:
                rec["close_nv"], rec["clv"] = round(nv_close, 4), round(nv_close - rec["nv"], 4)
            yes_bet = rec["nv"] if side == "A" else 1 - rec["nv"]
            v0, v1 = _implied_value(kind, rec["sport"], line, yes_bet), _implied_value(kind, rec["sport"], cl_line, yes_close)
            if v0 is not None and v1 is not None:
                rec["clv_pts"] = round((1 if side == "A" else -1) * (v1 - v0), 2)
            elif kind != "ml" and abs(cl_line - line) > 1e-6:  # no model for this sport's results (hockey totals): the moved line alone, in points
                rec["clv_pts"] = round((1 if side == "A" else -1) * ((cl_line - line) if kind == "total" else -(cl_line - line)), 2)
        rec["clv_done"] = True
        changed = True
    hs, as_ = g.get("home_score"), g.get("away_score")
    if rec.get("res") is None and g.get("completed") and hs is not None and as_ is not None and hs + as_ > 0:
        from .pricing import outcome

        out = outcome(kind, line, hs, as_)  # 1 when home covers / over / home wins
        res = 0.5 if out == 0.5 else (out if side == "A" else 1 - out)
        rec["res"] = res
        rec["pnl"] = round(profit_units(rec.get("dk_am0", rec["dk_am"])) if res == 1 else (-1.0 if res == 0 else 0.0), 4)
        changed = True
    return changed


def step(state: dict | None, closed_log: list | None, games: dict, kal: dict, now: datetime) -> tuple[dict, list, dict]:
    """One round: update the log. kal is {game id: {(kind, line): row}}. Returns (live state, closed list, {"opened": n, "closed": n})."""
    st = state or {}
    st = {"since": st.get("since") or now.isoformat(), "rounds": int(st.get("rounds", 0)) + 1, "open": dict(st.get("open") or {})}
    closed_list = list(closed_log or [])
    found = {}
    for gid, g in games.items():
        for a in find(g, list((kal.get(gid) or {}).values())):
            found[a["key"]] = a
    opened = closed = 0
    for key, a in found.items():
        rec = st["open"].get(key)
        if rec is None:
            st["open"][key] = {**a, "dk_am0": a["dk_am"], "first": now.isoformat(), "last": now.isoformat(), "rounds": 1, "best_cost": a["cost"], "best_size": a["size"], "best_fee": a["fee"], "best_at": now.isoformat(),
                               "max_size": a["size"] or 0, "first_size": a["size"]}
            opened += 1
        else:
            rec.update(last=now.isoformat(), rounds=rec["rounds"] + 1, dk_am=a["dk_am"], kp=a["kp"], cost=a["cost"], size=a["size"], vol=a["vol"], start=a["start"])
            rec["max_size"] = max(rec.get("max_size") or 0, a["size"] or 0)
            if a["cost"] < rec["best_cost"] - 1e-9 or (abs(a["cost"] - rec["best_cost"]) < 1e-9 and (a["size"] or 0) > (rec.get("best_size") or 0)):
                rec.update(best_cost=a["cost"], best_size=a["size"], best_fee=a["fee"], best_at=now.isoformat())
    for key in [k for k in st["open"] if k not in found]:
        rec = st["open"].pop(key)
        rec["closed"] = now.isoformat()
        rec["why"] = _gone_why(games.get(rec["gid"]), rec, list((kal.get(rec["gid"]) or {}).values()), now)
        closed_list.append(rec)
        closed += 1
    graded = sum(1 for rec in closed_list if grade(rec, games.get(rec["gid"])))
    return st, closed_list[-CLOSED_KEEP:], {"opened": opened, "closed": closed, "graded": graded}


def main() -> None:
    from .store import SbStore

    st = SbStore()
    meta = {r["key"]: r["value"] for r in st.rows("ex_meta")}
    a = meta.get("arbs") or {}
    print(f"tracking since {a.get('since')} over {a.get('rounds', 0)} rounds: {len(a.get('open') or {})} open, {len(meta.get('arbs_closed') or [])} closed")
    for r in (a.get("open") or {}).values():
        print(f"  open  {r['teams']:<14} {r['dk_label']} {r['dk_am']:+.0f} vs Kalshi {r['k_label']} {r['kp']*100:.0f}c | cost {r['cost']:.3f} | {r['size']} contracts | since {r['first'][11:16]}Z")


if __name__ == "__main__":
    main()
