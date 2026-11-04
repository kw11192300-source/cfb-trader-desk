"""Does the exchange's price carry information DraftKings does not have yet?

For every finished game with a DraftKings close, take the exchange's last price in each window before kickoff and its gap to DraftKings' price then, and ask two things: how far DraftKings later
moved toward it (slope 1.0 = all the way, 0 = not at all), and how far the result did. Run it before and after a change to how the exchange forms its price and compare:

    python -m exchange.gapcheck

Before sharp flow was made to stick (Nov 2026): the average gap was about 1 cent and predicted almost nothing (slope near 0 in college basketball, +0.3 to +0.5 in NBA, NFL and NHL on small samples).
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime

import numpy as np

from .store import SbStore

WINDOWS = [(48, 999, "48h+"), (24, 48, "24-48h"), (12, 24, "12-24h"), (6, 12, "6-12h"), (3, 6, "3-6h"), (1, 3, "1-3h"), (0, 1, "<1h")]
FAR = ("48h+", "24-48h", "12-24h", "6-12h", "3-6h")


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def slope(x: list[float], y: list[float]) -> tuple[float, float]:
    x, y = np.array(x), np.array(y)
    b = float(x @ y / (x @ x))
    e = y - b * x
    return b, float(math.sqrt(np.sum((x * e) ** 2)) / (x @ x))


def collect(store: SbStore) -> list[dict]:
    res = {r["id"]: r for r in store.rows("ex_results") if r.get("closing") and (r["closing"].get("src") or "dk") == "dk"}
    marks: dict[str, list[dict]] = defaultdict(list)
    for m in store.rows("ex_marks"):
        if m["game_id"] in res:
            marks[m["game_id"]].append(m)
    rows = []
    for gid, r in res.items():
        c, ko = r["closing"], _ts(r["kickoff"])
        cl = {(k, float(ln)): i for i, (k, ln) in enumerate(c["lines"])}
        ms = sorted(marks[gid], key=lambda m: m["ts"])
        for lo, hi, lab in WINDOWS:
            cand = [m for m in ms if lo <= (ko - _ts(m["ts"])).total_seconds() / 3600 < hi]
            if not cand:
                continue
            m = cand[-1]
            for j, (k, ln) in enumerate(m["lines"]):
                i = cl.get((k, float(ln)))
                if i is None or m["e"][j] is None or c["dk"][i] is None or c["y"][i] == 0.5:
                    continue
                rr = m["r"][j]
                rows.append({"b": lab, "sport": r["sport"], "kind": k, "gap": m["e"][j] - rr, "move": c["dk"][i] - rr, "res": c["y"][i] - rr, "g": gid})
    return rows


def main() -> None:
    rows = collect(SbStore())
    print(f"rows {len(rows)}, games {len({r['g'] for r in rows})}")
    print("\nslope of DraftKings' later move (and of the result) on the exchange's gap to DraftKings, by hours before kickoff (spreads and totals)")
    for _, _, lab in WINDOWS:
        s = [r for r in rows if r["b"] == lab and r["kind"] != "ml"]
        if len(s) < 30:
            continue
        g = [r["gap"] for r in s]
        b1, s1 = slope(g, [r["move"] for r in s])
        b2, s2 = slope(g, [r["res"] for r in s])
        print(f"  {lab:<7} n {len(s):4d} mean |gap| {np.mean(np.abs(g)):.3f}  to DK close {b1:+.2f} (t {b1 / s1 if s1 else 0:+.1f})  to result {b2:+.2f} (t {b2 / s2 if s2 else 0:+.1f})")
    print("\nby sport (3 hours or more out)")
    for sp in sorted({r["sport"] for r in rows}):
        s = [r for r in rows if r["sport"] == sp and r["kind"] != "ml" and r["b"] in FAR]
        if len(s) < 40:
            continue
        g = [r["gap"] for r in s]
        b1, s1 = slope(g, [r["move"] for r in s])
        print(f"  {sp:<4} n {len(s):4d}  to DK close {b1:+.2f} (t {b1 / s1 if s1 else 0:+.1f})")
    print("\nby size of the gap (3 hours or more out)")
    for lo, hi in ((0, 0.01), (0.01, 0.02), (0.02, 0.04), (0.04, 1.0)):
        s = [r for r in rows if lo <= abs(r["gap"]) < hi and r["kind"] != "ml" and r["b"] in FAR]
        if len(s) < 30:
            continue
        b1, s1 = slope([r["gap"] for r in s], [r["move"] for r in s])
        toward = sum(1 for r in s if abs(r["move"]) > 0.002 and r["gap"] * r["move"] > 0)
        away = sum(1 for r in s if abs(r["move"]) > 0.002 and r["gap"] * r["move"] < 0)
        print(f"  gap {lo:.2f}-{hi:.2f}: n {len(s):4d} slope {b1:+.2f} (t {b1 / s1 if s1 else 0:+.1f})  DK moved toward {toward}, away {away}")


if __name__ == "__main__":
    main()
