"""One-off repair for games that were settled with their home and away teams the wrong way round.

ESPN sometimes swaps which team it calls home on a neutral-site game around kickoff. The exchange had listed the game, priced it and traded it with one team at home; at settlement it read the final
score with the other team at home, so every moneyline and spread trade on it was settled the wrong way (FSU, a 97% favourite, "lost" to FAMU by 43). The totals were not affected.

    python -m exchange.repair <game id> [<game id> ...]          dry run: what would change
    python -m exchange.repair <game id> ... --apply              write it, after saving the rows it touches to data/repair_backup.json

For each game it puts the teams and scores back in the orientation the trades were made in, settles every trade again, and moves the difference through everything the settlement touched:
each trader's cash, realized profit, win and loss counts, result edge and settled profit; each firm's model-weight learning; the game's result row; the signal log; the reliability record.
The orientation is taken from the game's own moneyline: the team whose price the exchange's closing moneyline matches is the one that was at home.
"""
from __future__ import annotations

import copy
import json
import sys
import zlib
from pathlib import Path

from . import espn, pricing, reliability, results
from .store import SbStore

BACKUP = Path(__file__).resolve().parents[1] / "data" / "repair_backup.json"


def _res_delta(st: dict, sport: str, gid: str, old: float, new: float) -> None:
    d = st.get("res", {}).get(sport)
    if not d:
        return
    d["s"] += new - old
    d["q"] += new * new - old * old
    d["h"][zlib.crc32(gid.encode()) & 1][0] += new - old


def _bin(p: float) -> str:
    return str(min(reliability.BINS - 1, max(0, int(p * reliability.BINS))))


def _alt_contrib(trades: list[dict], outs: dict[str, float], main: dict, members: dict) -> dict:
    """What the by-distance record gets from these trades with these outcomes: {(entity, 'sport|kind', bucket): [n, contracts, sum price x q, sum outcome x q]}."""
    acc: dict = {}
    for t in trades:
        out, kind = outs[t["id"]], t["kind"]
        mn = main.get(kind)
        if out == 0.5 or kind not in ("spread", "total") or mn is None:
            continue
        b = reliability.off_bucket(abs(t["line"] - mn))
        p, q = t["price"], t["qty"]
        sides = [("x", p, out)] + [("s:wing", pp_, yy_) for who, pp_, yy_ in ((t["buyer"], p, out), (t["seller"], 1 - p, 1 - out)) if (members.get(who) or {}).get("syndicate_id") == "wing"]
        for ent, pp, yy in sides:
            c = acc.setdefault((ent, f"{{sport}}|{kind}", b), [0, 0.0, 0.0, 0.0])
            c[0] += 1
            c[1] += q
            c[2] += q * pp
            c[3] += q * yy
    return acc


def repair(store: SbStore, gids: list[str], apply: bool) -> None:
    members = {m["id"]: m for m in store.rows("ex_members")}
    syns = {s["id"]: s for s in store.rows("ex_syndicates")}
    meta = {r["key"]: r["value"] for r in store.rows("ex_meta")}
    rel = reliability.load(meta)
    sig = meta.get("signals") or {}
    backup: dict = {"ex_members": [], "ex_syndicates": [], "ex_trades": [], "ex_games": [], "ex_results": [], "ex_meta": []}
    touched_members: dict[str, dict] = {}
    touched_syns: dict[str, dict] = {}
    changed_trades: list[dict] = []
    new_games: list[dict] = []
    new_results: list[dict] = []
    summary = []
    old_members = {k: copy.deepcopy(v) for k, v in members.items()}

    for gid in gids:
        g = next(x for x in store.rows("ex_games", {"id": gid}))
        sport = g["sport"]
        trades = sorted(store.rows("ex_trades", {"game_id": gid}), key=lambda t: t["ts"])
        old_row = next(r for r in store.rows("ex_results", {"id": gid}))
        v = g.get("views") or {}
        # which team was at home when the trades were made: the one whose price the closing moneyline is
        cl = old_row["closing"]
        i_ml = [k for k, _ in cl["lines"]].index("ml")
        p_close = cl["dk"][i_ml]
        meta_ml = (g.get("ref") or {}).get("ml_home")
        print(f"\n== {gid}  stored {g['away']['abbr']} @ {g['home']['abbr']}  score {g['away_score']}-{g['home_score']}  closing moneyline (home yes) {p_close}  ref ml_home now {meta_ml}")
        # the trades' own prices say it too
        ml_refs = [t["ref_p"] for t in trades if t["kind"] == "ml" and t.get("ref_p") is not None]
        if ml_refs:
            print(f"   moneyline trade prices vs DK at the time: {min(ml_refs):.3f} .. {max(ml_refs):.3f} (the closing price above is the same team's)")
        # corrected game: teams and scores swapped
        ng = copy.deepcopy(g)
        ng["home"], ng["away"] = g["away"], g["home"]
        ng["home_score"], ng["away_score"] = g["away_score"], g["home_score"]
        # the stored line should be in the same orientation as the trades: flip it if its moneyline is not the closing moneyline's team
        ref = g.get("ref") or {}
        ref_p = None
        if ref.get("ml_home") is not None:
            ref_p = (-ref["ml_home"] / (-ref["ml_home"] + 100)) if ref["ml_home"] < 0 else 100 / (ref["ml_home"] + 100)
        flip_ref = ref_p is not None and abs(ref_p - p_close) > 0.15 and abs((1 - ref_p) - p_close) < 0.15
        if flip_ref:
            ng["ref"] = espn.flip_odds(ref)
            if g.get("ref_open"):
                ro = g["ref_open"]
                ng["ref_open"] = {**ro, "spread": None if ro.get("spread") is None else -ro["spread"], "ml_home": ro.get("ml_away") if ro.get("ml_away") is not None else ro.get("ml_home")}
            print("   stored line was in the other orientation: flipped it too")
        print(f"   corrected: {ng['away']['abbr']} @ {ng['home']['abbr']}  score {ng['away_score']}-{ng['home_score']}")
        new_games.append(ng)

        # settle every trade again
        old_out = {t["id"]: t["outcome"] for t in trades}
        new_out = {t["id"]: pricing.outcome(t["kind"], t["line"], ng["home_score"], ng["away_score"]) for t in trades}
        flips = [t for t in trades if old_out[t["id"]] != new_out[t["id"]]]
        print(f"   trades {len(trades)}, outcomes that change: {len(flips)} ({sum(t['qty'] for t in flips):.0f} contracts)")
        for t in flips:
            t2 = dict(t)
            t2["outcome"] = new_out[t["id"]]
            changed_trades.append(t2)
            cp = t.get("close_p")
            for side in ("buyer", "seller"):
                m = members[t[side]]
                touched_members[m["id"]] = m
                rem = t["rem_b"] if side == "buyer" else t["rem_s"]
                cost = rem * (t["price"] if side == "buyer" else 1 - t["price"])
                win_o = old_out[t["id"]] if side == "buyer" else 1 - old_out[t["id"]]
                win_n = new_out[t["id"]] if side == "buyer" else 1 - new_out[t["id"]]
                pay_o, pay_n = rem * win_o, rem * win_n
                pnl_o, pnl_n = pay_o - cost, pay_n - cost
                d = pay_n - pay_o
                m["cash"] += d
                m["realized"] += d
                if "equity" in m:
                    m["equity"] += d
                st = m["stats"]
                role = "maker" if t["maker"] == m["id"] else "taker"
                st[f"pnl_{role}"] += d
                if rem > 0:
                    st["wins"] += int(pnl_n > 0) - int(pnl_o > 0)
                    st["losses"] += int(pnl_n < 0) - int(pnl_o < 0)
                if cp is not None:
                    ro = (old_out[t["id"]] - cp) if side == "buyer" else (cp - old_out[t["id"]])
                    rn = (new_out[t["id"]] - cp) if side == "buyer" else (cp - new_out[t["id"]])
                    _res_delta(st, sport, gid, ro, rn)

        # the result row, and each trader's settled profit
        for t in trades:
            t["outcome"] = new_out[t["id"]]
        new_row = results.game_result(ng, trades, members)
        new_row["settled_at"] = old_row.get("settled_at") or new_row["settled_at"]
        for mid, vv in new_row["traders"].items():
            old_pnl = (old_row["traders"].get(mid) or {}).get("pnl", 0.0)
            if abs(vv["pnl"] - old_pnl) > 1e-9:
                st = members[mid]["stats"]
                st["s_pnl"] = st.get("s_pnl", 0.0) + (vv["pnl"] - old_pnl)
                touched_members[mid] = members[mid]
        for mid, vv in old_row["traders"].items():
            if mid not in new_row["traders"]:
                members[mid]["stats"]["s_pnl"] = members[mid]["stats"].get("s_pnl", 0.0) - vv["pnl"]
                touched_members[mid] = members[mid]
        new_results.append(new_row)

        # each firm's model-weight learning used the same scores
        for sid, es in (v.get("e") or {}).items():
            if sid not in syns:
                continue
            ls = (syns[sid].get("learn") or {})
            st = (ls.get("stats") or {}).get(sport)
            if not st:
                continue
            cal = (ls.get("calib") or {}).get(sport)
            for (kind, line), r, e in zip(v["lines"], v["r"], es):
                if r is None or e is None:
                    continue
                o_old = pricing.outcome(kind, line, g["home_score"], g["away_score"])
                o_new = pricing.outcome(kind, line, ng["home_score"], ng["away_score"])
                if o_old == 0.5 or o_new == 0.5 or o_old == o_new:
                    continue
                st["num"] += (o_new - o_old) * (e - r)
                if cal:
                    for who, pr in (("model", e), ("market", r)):
                        cal[who][min(9, int(pr * 10))][1] += o_new - o_old
            touched_syns[sid] = syns[sid]

        # the signal log
        n_sig = 0
        for s in sig.get("done", []):
            if s["game"] != gid:
                continue
            y = pricing.outcome(s["kind"], s["line"], ng["home_score"], ng["away_score"])
            if y == 0.5:
                continue
            s["y"] = y
            s["pnl_dk"] = round(s["side"] * (y - s["ref"]), 4)
            s["pnl_x"] = None if s.get("x") is None else round(s["side"] * (y - s["x"]), 4)
            n_sig += 1
        print(f"   signals rescored: {n_sig}")

        # the reliability record: yes-side outcomes by price bin, and the by-distance record
        for t in flips:
            q, p, d = t["qty"], t["price"], new_out[t["id"]] - old_out[t["id"]]
            sk = f"{sport}|{t['kind']}"
            for ent, pp, dd in (("x", p, d), (f"s:{members[t['buyer']]['syndicate_id']}", p, d), (f"m:{t['buyer']}", p, d), (f"s:{members[t['seller']]['syndicate_id']}", 1 - p, -d), (f"m:{t['seller']}", 1 - p, -d)):
                cell = rel["cells"].setdefault(ent, {}).setdefault(sk, {}).setdefault(_bin(pp), [0, 0.0, 0.0, 0.0])
                cell[3] += q * dd
        main_old = {"spread": (g.get("ref") or {}).get("spread"), "total": (g.get("ref") or {}).get("total")}
        main_new = {"spread": (ng.get("ref") or {}).get("spread"), "total": (ng.get("ref") or {}).get("total")}
        old_c = _alt_contrib(trades, old_out, main_old, members)
        new_c = _alt_contrib(trades, new_out, main_new, members)
        for k in set(old_c) | set(new_c):
            ent, sk_t, b = k
            sk = sk_t.format(sport=sport)
            cell = rel["alt"].setdefault(ent, {}).setdefault(sk, {}).setdefault(b, [0, 0.0, 0.0, 0.0])
            for i in range(4):
                cell[i] += (new_c.get(k, [0, 0.0, 0.0, 0.0])[i]) - (old_c.get(k, [0, 0.0, 0.0, 0.0])[i])
        summary.append((gid, len(flips)))

    # ---- what moved
    print("\ncash moved per firm (sum of its traders):")
    byfirm: dict[str, float] = {}
    for mid, m in touched_members.items():
        d = m["cash"] - old_members[mid]["cash"]
        byfirm[m["syndicate_id"]] = byfirm.get(m["syndicate_id"], 0.0) + d
    for sid, d in sorted(byfirm.items(), key=lambda kv: -kv[1]):
        print(f"   {syns[sid]['name']:<22} {d:+9.2f}")
    print(f"   total (must be zero): {sum(byfirm.values()):+.6f}")

    if not apply:
        print("\ndry run: nothing written. Add --apply to write it.")
        return
    for mid in touched_members:
        backup["ex_members"].append(old_members[mid])
    for sid in touched_syns:
        backup["ex_syndicates"].append(store.rows("ex_syndicates", {"id": sid})[0])
    for t in changed_trades:
        backup["ex_trades"].append(next(x for x in store.rows("ex_trades", {"id": t["id"]})))
    for ng in new_games:
        backup["ex_games"].append(store.rows("ex_games", {"id": ng["id"]})[0])
    for r in new_results:
        backup["ex_results"].append(store.rows("ex_results", {"id": r["id"]})[0])
    backup["ex_meta"] = [{"key": "rel", "value": meta.get("rel")}, {"key": "signals", "value": meta.get("signals")}]
    BACKUP.write_text(json.dumps(backup))
    print(f"\nbackup of every row it touches saved to {BACKUP}")
    store.upsert("ex_trades", changed_trades)
    store.upsert("ex_members", list(touched_members.values()))
    store.upsert("ex_syndicates", list(touched_syns.values()))
    store.upsert("ex_games", new_games)
    store.upsert("ex_results", new_results)
    store.upsert("ex_meta", [{"key": "rel", "value": reliability.dump(rel)}, {"key": "signals", "value": sig}])
    print("written")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    repair(SbStore(), args, "--apply" in sys.argv)


if __name__ == "__main__":
    main()
