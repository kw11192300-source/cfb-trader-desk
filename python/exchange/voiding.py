"""Void every trade on a game and put the accounts back as if they had never happened, while the game stays open for trading.

Used when a game traded on a wrong reference price (exchange/pricing.py once read a one-sided DraftKings spread as a pick'em, so a 33-point favourite priced at 1 cent). An ordinary void (a game
that is called off) refunds what is still held at settlement, but the profit already banked from netting trades against each other at the bad prices stays banked, and every settled trade feeds the
closing-line records that decide who is sharp. This undoes all of it exactly, by replaying the game's trades in order the way the engine filled them:

  cash, locked, realized     back to what they were before the first trade on the game
  maker / taker counters     trades, volume, profit by role, and the maker's capture against DraftKings
  trades                     deleted from the ledger and archived (ex_meta "voided:<game>")
  the game's logs            signals, sharp piles, line-move events, price marks and carried-over market-maker reads

It runs inside the round (engine.run_round reads ex_meta "void_requests") so it commits with the round's own writes and cannot race a round in flight. A game with any settled trade is refused.
Request one:   python -m exchange.voiding <game id> [--reason "..."]   (writes the request; the next round carries it out)
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import datetime, timezone


def _order(t: dict) -> tuple[int, int]:
    try:
        r, n = t["id"][1:].split("-")
        return int(r), int(n)
    except Exception:
        return (10**9, 0)


def reverse(trades: list[dict], members: dict) -> dict:
    """Replay the game's trades in fill order, check the replay reproduces what the ledger holds, then undo every effect on `members` in place. Returns a summary."""
    ts = sorted(trades, key=_order)
    lots: dict[str, list[dict]] = defaultdict(list)  # member -> lots in fill order, each {"t", "side", "rem", "px"}
    acc: dict[str, dict] = defaultdict(lambda: {"pnl": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0, "n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "cap_sum": 0.0, "cap_q": 0.0})
    rem: dict[str, dict] = {}

    def close(mid: str, t: dict, closing_long: bool, px: float, qty: float, role: str) -> float:
        left, done = qty, 0.0
        for lot in lots[mid]:
            if left < 1e-9:
                break
            lt = lot["t"]
            if lt["kind"] != t["kind"] or lt["line"] != t["line"]:
                continue
            if closing_long and lot["side"] == "b" and lot["rem"] > 1e-9:
                u = min(lot["rem"], left)
                pnl = u * (px - lot["px"])
            elif not closing_long and lot["side"] == "s" and lot["rem"] > 1e-9:
                u = min(lot["rem"], left)
                pnl = u * (lot["px"] - px)
            else:
                continue
            lot["rem"] -= u
            a = acc[mid]
            a["pnl"] += pnl
            a[f"pnl_{role}"] += pnl
            left -= u
            done += u
        return done

    for t in ts:
        px, q = t["price"], t["qty"]
        b, s = t["buyer"], t["seller"]
        cb = close(b, t, False, px, q, "maker" if t["maker"] == b else "taker")  # the buyer buys back what it was short
        cs = close(s, t, True, px, q, "maker" if t["maker"] == s else "taker")  # the seller sells out of what it was long
        rb, rs = q - cb, q - cs
        rem[t["id"]] = {"b": rb, "s": rs}
        if rb > 1e-9:
            lots[b].append({"t": t, "side": "b", "rem": rb, "px": px, "id": t["id"]})
        if rs > 1e-9:
            lots[s].append({"t": t, "side": "s", "rem": rs, "px": px, "id": t["id"]})
        for who, buyer in ((b, True), (s, False)):
            role = "maker" if t["maker"] == who else "taker"
            a = acc[who]
            a[f"n_{role}"] += 1
            a[f"vol_{role}"] += q * (px if buyer else 1 - px)
        ref = t.get("ref_p")
        if ref is not None:
            cap = (px - ref) if t["maker"] == s else (ref - px)  # what the maker earned against DraftKings at the fill
            a = acc[t["maker"]]
            a["cap_sum"] += q * cap
            a["cap_q"] += q
    # the replay must reproduce what the ledger holds, or something is not as assumed: refuse rather than guess
    bad = []
    left_lots: dict[str, float] = defaultdict(float)
    for mid, ls in lots.items():
        for lot in ls:
            left_lots[lot["id"] + lot["side"]] = lot["rem"]
    for t in ts:
        rb = left_lots.get(t["id"] + "b", 0.0)
        rs = left_lots.get(t["id"] + "s", 0.0)
        sb = t["rem_b"] if t.get("rem_b") is not None else t["qty"]
        ss = t["rem_s"] if t.get("rem_s") is not None else t["qty"]
        if abs(rb - sb) > 1e-4 or abs(rs - ss) > 1e-4:
            bad.append((t["id"], round(rb, 4), round(sb, 4), round(rs, 4), round(ss, 4)))
    if bad:
        raise RuntimeError(f"replay does not match the ledger on {len(bad)} trades, e.g. {bad[:3]}; nothing was changed")
    out = {"trades": len(ts), "members": {}}
    for mid, a in acc.items():
        cost = sum(l["rem"] * (l["px"] if l["side"] == "b" else 1 - l["px"]) for l in lots[mid])  # collateral still locked behind what it holds
        m = members[mid]
        m["cash"] += cost - a["pnl"]
        m["locked"] -= cost
        m["realized"] -= a["pnl"]
        st = m["stats"]
        for role in ("maker", "taker"):
            st[f"pnl_{role}"] = st.get(f"pnl_{role}", 0.0) - a[f"pnl_{role}"]
            st[f"n_{role}"] = st.get(f"n_{role}", 0) - a[f"n_{role}"]
            st[f"vol_{role}"] = st.get(f"vol_{role}", 0.0) - a[f"vol_{role}"]
        st["cap_sum"] = st.get("cap_sum", 0.0) - a["cap_sum"]
        st["cap_q"] = st.get("cap_q", 0.0) - a["cap_q"]
        out["members"][mid] = {"cost": round(cost, 3), "banked": round(a["pnl"], 3)}
    return out


def clean_meta(meta: dict, gid: str) -> None:
    """Take a game out of the round's in-memory logs (signals, piles, line-move events, carried-over market-maker reads), so the engine's own later writes cannot put it back."""
    sig = meta.get("signals")
    if sig:
        for part in ("open", "done"):
            if isinstance(sig.get(part), dict):
                sig[part] = {k: v for k, v in sig[part].items() if v.get("game") != gid}
    pil = meta.get("piles")
    if pil:
        pil["open"] = {k: v for k, v in (pil.get("open") or {}).items() if v.get("gid") != gid}
        pil["recent"] = [r for r in pil.get("recent", []) if r.get("game") != gid]
    mv = meta.get("moves")
    if mv:
        mv["rows"] = [r for r in mv.get("rows", []) if r.get("gid") != gid]
    car = meta.get("carry")
    if car:
        car["mmb"] = [r for r in car.get("mmb", []) if r[1] != gid]
        car["tox"] = [r for r in car.get("tox", []) if not str(r[1]).startswith(f"{gid}|")]


def apply(store, meta: dict, members: dict, open_trades: list[dict], games: dict, now: datetime) -> tuple[list[dict], callable | None]:
    """Carry out the pending requests against this round's in-memory state. Returns the trades that remain open and a function to call when the round writes back (deletes, archives, clears the logs)."""
    req = (meta.get("void_requests") or {}).get("games") or []
    if not req:
        return open_trades, None
    reason = (meta.get("void_requests") or {}).get("reason", "")
    done: list[dict] = []
    for gid in req:
        mine = [t for t in open_trades if t["game_id"] == gid]
        if not mine:
            done.append({"gid": gid, "skipped": "no open trades"})
            continue
        summary = reverse(mine, members)
        done.append({"gid": gid, "trades": [{k: t.get(k) for k in ("id", "ts", "kind", "line", "price", "qty", "buyer", "seller", "maker", "ref_p")} for t in mine], "summary": summary})
        ids = {t["id"] for t in mine}
        open_trades = [t for t in open_trades if t["id"] not in ids]
        clean_meta(meta, gid)
        g = games.get(gid)
        if g and g.get("views"):
            g["views"].pop("flow", None)  # the sharp flow the bad fills created

    def commit() -> None:
        for d in done:
            gid = d["gid"]
            if d.get("skipped"):
                continue
            ids = [t["id"] for t in d["trades"]]
            store.upsert("ex_meta", [{"key": f"voided:{gid}", "value": {"ts": now.isoformat(), "reason": reason, "trades": d["trades"], "summary": d["summary"]}}])
            store.delete_in("ex_trades", "id", ids)
            store.delete_in("ex_marks", "game_id", [gid])
        for key in ("signals", "piles", "moves", "carry"):
            if meta.get(key) is not None:
                store.upsert("ex_meta", [{"key": key, "value": meta[key]}])
        store.upsert("ex_meta", [{"key": "void_requests", "value": {"games": [], "reason": "", "last": [{"gid": d["gid"], "ts": now.isoformat(), "n": len(d.get("trades", []))} for d in done]}}])

    return open_trades, commit


def main() -> None:
    from .store import SbStore

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    reason = sys.argv[sys.argv.index("--reason") + 1] if "--reason" in sys.argv else "voided by request"
    if not args:
        raise SystemExit("usage: python -m exchange.voiding <game id> [--reason \"...\"]")
    store = SbStore()
    cur = next((r["value"] for r in store.rows("ex_meta") if r["key"] == "void_requests"), None) or {}
    games = sorted(set((cur.get("games") or []) + [a for a in args if a != reason]))
    store.upsert("ex_meta", [{"key": "void_requests", "value": {"games": games, "reason": reason}}])
    print("requested; the next round voids all trades on", games, "and reopens trading on them")


if __name__ == "__main__":
    main()
