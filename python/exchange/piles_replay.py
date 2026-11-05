"""Rebuild the sharp-pile track record from the trade ledger under a chosen definition of "sharp".

The track record (ex_meta "piles") keeps only running totals, so it cannot be recomputed when the definition of sharpness changes. This replays every trade still in the ledger in time order, tracks each account's
net position on each line, works out the sharpness-weighted pile after every trade, opens an entry the first time a pile reaches each size, and scores finished games exactly as exchange/piles.py does.

    python -m exchange.piles_replay            compare: the stored record, a replay with the sharpness scores as stored (the old definition), and a replay with the new definition
    python -m exchange.piles_replay --reset    archive the stored record (ex_meta "piles_v1") and start a fresh one under the new definition

New definition: a firm whose closing-line record in a sport is clearly negative (pooled over its takers: the average plus 1.645 standard errors is still under zero, over 100 or more takes) keeps only the
closing-line part of its sharpness in that sport, never the part its model weight would give it (engine.sharp_parts).
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from . import piles, pricing

SHARP_CLV = 0.02
SHARP_N = 25.0
SHARP_BAD_N = 100
SPORTS = ("nfl", "cfb", "nhl", "nba", "cbb")


def _pd(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def s1_of(stats: dict, sport: str) -> float:
    rec = (stats.get("clvs") or {}).get(sport)
    if not rec or rec["n"] < 2:
        return 0.0
    n = rec["n"]
    mean = rec["s"] / n
    se = math.sqrt(max(0.0, rec["q"] / n - mean * mean) / n)
    return max(0.0, min(1.0, (mean - se) / SHARP_CLV)) * n / (n + SHARP_N)


def maps(store) -> tuple[dict, dict, dict]:
    """(old, new, bad): sharpness by (member, sport) as stored, with the closing-line rule applied, and the firms switched off by it."""
    members = store.rows("ex_members")
    syn_name = {s["id"]: s["name"] for s in store.rows("ex_syndicates")}
    pooled: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for m in members:
        if m["params"].get("public"):
            continue
        for sp, r in (m["stats"].get("clvs") or {}).items():
            a = pooled[(m["syndicate_id"], sp)]
            a[0] += r["n"]; a[1] += r["s"]; a[2] += r["q"]
    bad = {}
    for (sid, sp), (n, s, q) in pooled.items():
        if n >= SHARP_BAD_N:
            mean = s / n
            if mean + 1.645 * math.sqrt(max(0.0, q / n - mean * mean) / n) < 0:
                bad[(sid, sp)] = (syn_name[sid], round(mean * 100, 2), int(n))
    old, new = {}, {}
    for m in members:
        st = m["stats"]
        for sp in SPORTS:
            o = float((st.get("sharp") or {}).get(sp, 0.0))
            old[(m["id"], sp)] = o
            new[(m["id"], sp)] = min(o, s1_of(st, sp)) if (m["syndicate_id"], sp) in bad and not m["params"].get("public") else o
            if (m["syndicate_id"], sp) in bad:
                new[(m["id"], sp)] = s1_of(st, sp) if o > 0 else 0.0
    return old, new, bad


def replay(trades: list[dict], games: dict[str, dict], provider, public: set[str], fade: str | None = None) -> dict:
    """{"cells", "open", "recent", "fc"} from the ledger under this sharpness map. fc[t] splits the entries by whether one firm (`fade`'s members) holds half the pile or more."""
    by_game: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        by_game[t["game_id"]].append(t)
    cells: dict[str, list] = {}
    open_: dict[str, dict] = {}
    recent: list[dict] = []
    split: dict[str, list] = defaultdict(lambda: [0, 0, 0.0])  # "t|fc" or "t|other": n, wins, pnl
    for gid, ts in sorted(by_game.items(), key=lambda kv: min(t["ts"] for t in kv[1])):
        g = games.get(gid)
        if not g or g.get("voided"):
            continue
        sport = g["sport"]
        sharp = provider(gid, min(t["ts"] for t in ts))
        start = _pd(g["start_utc"])
        net: dict[tuple, dict[str, float]] = defaultdict(dict)  # (kind, line) -> member -> net contracts
        ent: dict[tuple, dict] = {}  # (kind, line, side) -> entry
        info: dict[tuple, dict] = {}
        for t in sorted(ts, key=lambda t: (t["ts"], t["id"])):
            key = (t["kind"], t["line"])
            hold = net[key]
            q = t["qty"]
            hold[t["buyer"]] = hold.get(t["buyer"], 0.0) + q
            hold[t["seller"]] = hold.get(t["seller"], 0.0) - q
            hrs = (start - _pd(t["ts"])).total_seconds() / 3600.0
            if hrs < 0.25:
                continue
            v = 0.0
            long = short = 0
            top = 0.0
            fc_w = 0.0
            for mid, nq in hold.items():
                if abs(nq) < 0.5 or mid in public:
                    continue
                s = sharp.get((mid, sport), 0.0)
                if s < piles.MIN_SHARP:
                    continue
                v += nq * s
                long += nq > 0
                short += nq < 0
                top = max(top, s)
                if fade and mid.startswith(fade):
                    fc_w += nq * s
            if abs(v) < piles.THRS[0]:
                continue
            side = 1 if v > 0 else -1
            e = ent.setdefault((key[0], key[1], side), {"gid": gid, "kind": key[0], "line": key[1], "sport": sport, "side": side, "thr": {}})
            for th in piles.THRS:
                if abs(v) >= th and str(th) not in e["thr"]:
                    e["thr"][str(th)] = {"ts": t["ts"], "hrs": round(hrs, 1), "ref": round(t["ref_p"], 4), "v": round(abs(v), 1), "n": long if side > 0 else short, "opp": short if side > 0 else long, "top": round(top, 2),
                                         "fc": abs(fc_w) / abs(v) if v else 0.0}
        if not ent:
            continue
        done = bool(g.get("completed")) and g.get("home_score") is not None
        for (kind, line, side), e in ent.items():
            if not done:
                open_[f"{pricing.ckey(gid, kind, line)}|{side}"] = e
                continue
            y = pricing.outcome(kind, line, g["home_score"], g["away_score"])
            if y == 0.5:
                continue
            close = next((t["close_p"] for t in by_game[gid] if t["kind"] == kind and t["line"] == line and t.get("close_p") is not None), None)
            for th, x in e["thr"].items():
                pnl = side * (y - x["ref"])
                clv = None if close is None else side * (close - x["ref"])
                for grp in piles.groups({**x, "sport": sport, "kind": kind}):
                    c = cells.setdefault(f"{th}|{grp}", [0, 0, 0.0, 0.0, 0.0, 0.0, 0])
                    c[0] += 1; c[1] += pnl > 0; c[2] += pnl; c[3] += pnl * pnl
                    if clv is not None:
                        c[4] += clv; c[5] += clv * clv; c[6] += 1
                sp_ = split[f"{th}|{'fc' if x['fc'] >= 0.5 else 'other'}"]
                sp_[0] += 1; sp_[1] += pnl > 0; sp_[2] += pnl
                if th == str(piles.THRS[2]):
                    recent.append({"game": gid, "teams": f"{g['away']['abbr']} @ {g['home']['abbr']}", "sport": sport, "kind": kind, "line": line, "side": side, "ref": x["ref"], "close": close, "y": y, "v": x["v"],
                                   "n": x["n"], "opp": x["opp"], "top": x["top"], "ts": x["ts"], "start": g["start_utc"]})
    recent.sort(key=lambda r: r["start"], reverse=True)
    for o in open_.values():
        for x in o["thr"].values():
            x.pop("fc", None)
    return {"cells": cells, "open": open_, "recent": [{k: v for k, v in r.items() if k != "start"} for r in recent[: piles.RECENT]], "split": dict(split)}


def static_provider(sharp: dict):
    return lambda gid, ts: sharp


def asof_provider(trades: list[dict], games: dict[str, dict]):
    """Sharpness from the closing-line record alone, as each account's record stood when a game's first trade was made: only games that had finished by then count. No hindsight."""
    by_game: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        by_game[t["game_id"]].append(t)
    finish = sorted(((_pd(games[g]["start_utc"]).timestamp() + 3 * 3600, g) for g in by_game if g in games and games[g].get("completed")), key=lambda x: x[0])
    rec: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    state: dict = {"i": 0, "map": {}}

    def absorb(gid: str) -> None:
        sport = games[gid]["sport"]
        for t in by_game[gid]:
            if t.get("close_p") is None or t.get("ref_p") is None:
                continue
            taker_buys = t["maker"] == t["seller"]
            d = (t["close_p"] - t["ref_p"]) * (1 if taker_buys else -1)  # DraftKings' move toward what the taker took, from the price at the time of the fill
            r = rec[(t["buyer"] if taker_buys else t["seller"], sport)]
            r[0] += 1
            r[1] += d
            r[2] += d * d

    def provider(gid: str, first_ts: str) -> dict:
        cut = _pd(first_ts).timestamp()
        moved = False
        while state["i"] < len(finish) and finish[state["i"]][0] <= cut:
            absorb(finish[state["i"]][1])
            state["i"] += 1
            moved = True
        if moved or not state["map"]:
            out = {}
            for (mid, sport), (n, sm, q) in rec.items():
                if n >= 2:
                    mean = sm / n
                    se = math.sqrt(max(0.0, q / n - mean * mean) / n)
                    out[(mid, sport)] = max(0.0, min(1.0, (mean - se) / SHARP_CLV)) * n / (n + SHARP_N)
            state["map"] = out
        return state["map"]

    return provider


def _line(label: str, c: list | None) -> str:
    if not c or c[0] == 0:
        return f"  {label:<34} (none)"
    n, hits, pnl, sq, clv, _, nc = c
    exp = (hits - pnl) / n
    act = hits / n
    se = math.sqrt(max(1e-9, exp * (1 - exp) / n))
    return f"  {label:<34} n {n:5d} | hit {act*100:5.1f}% vs expected {exp*100:5.1f}% (z {(act-exp)/se:+.1f}) | made {pnl/n*100:+5.2f}c per contract | DK moved toward it {'' if not nc else format(clv/nc*100, '+.2f') + 'c'}"


def main() -> None:
    from .store import SbStore

    store = SbStore()
    old_meta = next((r["value"] for r in store.rows("ex_meta") if r["key"] == "piles"), {})
    old, new, bad = maps(store)
    print("firms switched off by the closing-line rule (sport: firm, average DK move toward its takes, takes):")
    for (sid, sp), (name, mean, n) in sorted(bad.items(), key=lambda kv: kv[1][1]):
        print(f"  {sp}: {name:<20} {mean:+.2f}c over {n}")
    members = store.rows("ex_members")
    public = {m["id"] for m in members if m["params"].get("public")}
    games = {g["id"]: g for g in store.rows("ex_games")}
    trades = store.rows("ex_trades")
    print(f"\nledger: {len(trades)} trades on {len({t['game_id'] for t in trades})} games")
    r_old = replay(trades, games, static_provider(old), public, fade="fade-")  # today's stored scores applied to the whole history: hindsight, so flattering
    r_hn = replay(trades, games, static_provider(new), public, fade="fade-")  # the closing-line rule applied to today's scores: still hindsight, but without the firms the closing line says are not sharp
    r_new = replay(trades, games, asof_provider(trades, games), public, fade="fade-")  # closing-line sharpness alone, as it stood at the time: no hindsight, but few piles reach the sizes below
    for th in piles.THRS:
        print(f"\npile reaches {th}+ sharp-weighted contracts:")
        print(_line("stored record (as shown on the page)", old_meta.get("cells", {}).get(f"{th}|all")))
        print(_line("hindsight replay, old scores", r_old["cells"].get(f"{th}|all")))
        print(_line("hindsight replay, rule applied", r_hn["cells"].get(f"{th}|all")))
        print(_line("closing-line record as of then", r_new["cells"].get(f"{th}|all")))
    print("\nhindsight replay, split by whether Fade Club held half the pile or more (pnl is per contract, from the DraftKings price at the time):")
    for th in ("10", "20", "40"):
        for k in ("fc", "other"):
            n, w, p = r_old["split"].get(f"{th}|{k}", [0, 0, 0.0])
            if n:
                print(f"  {th}+ {'Fade Club led' if k == 'fc' else 'someone else led':<18} n {n:5d} | hit {w/n*100:5.1f}% | made {p/n*100:+5.2f}c")
    print("\nclosing-line-proven piles by sport at 10+:")
    for sp in SPORTS:
        print(_line(sp, r_new["cells"].get(f"10|sport:{sp}")))
    print(f"\nopen piles waiting on games: stored {len(old_meta.get('open', {}))}, replay on the proven definition {len(r_new['open'])}")
    if "--reset" in sys.argv:
        # a replay cannot give a clean record: today's scores applied to the past are hindsight, and the closing-line-only version leaves too few piles. So the old record is archived as it stood and a fresh one starts
        # under the new definition; the next round opens entries for the piles that exist then, at that moment's DraftKings prices.
        if not any(r["key"] == "piles_v1" for r in store.rows("ex_meta")):
            store.upsert("ex_meta", [{"key": "piles_v1", "value": old_meta}])
            Path(__file__).resolve().parents[1].joinpath("data").mkdir(parents=True, exist_ok=True)
            (Path(__file__).resolve().parents[1] / "data" / "piles_v1.json").write_text(json.dumps(old_meta))
        store.upsert("ex_meta", [{"key": "piles", "value": {"open": {}, "cells": {}, "recent": []}}])
        print("the old record is archived as ex_meta 'piles_v1'; a fresh track record starts now under the new definition")


if __name__ == "__main__":
    main()
