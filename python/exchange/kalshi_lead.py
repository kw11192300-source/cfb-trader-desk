"""Does Kalshi's price on a game's total move before DraftKings'?  python -m exchange.kalshi_lead [--days 3] [--sport cbb]

The engine writes Kalshi's mid on each main line into the same mark row as DraftKings' price (entries of kind "kal:total", "kal:spread", "kal:ml"; see KAL_LOG_MIN in engine.py).
Both prices are turned into an implied total (the line plus the price's z-score times the sport's standard deviation), so a 1-cent difference means the same thing at any line. Then:

  lead:  the gap (Kalshi's implied total minus DraftKings') against what DraftKings does over the next 30, 60 and 120 minutes. A positive slope means DraftKings moves toward Kalshi, so Kalshi is early.
  lag:   the reverse, the gap against what Kalshi does next. A positive slope there means Kalshi moves toward DraftKings.

Slopes are in "points of later movement per point of gap" (1.0 = the gap closes entirely by DraftKings moving), with standard errors clustered by game. Reading: lead clearly above lag means Kalshi is the early signal."""
from __future__ import annotations

import argparse
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.special import ndtri

from .pricing import SIGMA

HORIZONS = (30, 60, 120)  # minutes
GRID_MIN = 5


def _implied(line: float, p: float, sport: str) -> float | None:
    if p is None or not (0.03 < p < 0.97):
        return None
    return line + SIGMA[sport][1] * float(ndtri(p))


def series(rows: list[dict], sport_of: dict) -> dict:
    """{game: (grid times, DraftKings implied totals, Kalshi implied totals)} on a regular grid, each forward-filled from the latest mark."""
    by = defaultdict(list)
    for r in rows:
        by[r["game_id"]].append(r)
    out = {}
    for gid, rs in by.items():
        sport = sport_of.get(gid)
        if not sport or sport not in SIGMA:  # hockey totals are Poisson, not normal: no standard deviation to turn a price into a total
            continue
        rs.sort(key=lambda r: r["ts"])
        pts = []
        for r in rs:
            lines, pr = r["lines"], r["r"]
            try:
                i = next(k for k, x in enumerate(lines) if x[0] == "total")
                j = next(k for k, x in enumerate(lines) if x[0] == "kal:total")
            except StopIteration:
                continue
            d, k = _implied(lines[i][1], pr[i], sport), _implied(lines[j][1], pr[j], sport)
            if d is None or k is None:
                continue
            pts.append((datetime.fromisoformat(r["ts"]), d, k))
        if len(pts) < 12:
            continue
        t0, t1 = pts[0][0], pts[-1][0]
        n = int((t1 - t0).total_seconds() // (GRID_MIN * 60)) + 1
        grid, dk, ka, j = [], np.empty(n), np.empty(n), 0
        for g in range(n):
            t = t0 + timedelta(minutes=GRID_MIN * g)
            while j + 1 < len(pts) and pts[j + 1][0] <= t:
                j += 1
            grid.append(t)
            dk[g], ka[g] = pts[j][1], pts[j][2]
        out[gid] = (grid, dk, ka)
    return out


def slope(x: list, y: list, groups: list) -> tuple[float, float, int]:
    """Regression slope of y on x (with an intercept) and its game-clustered standard error."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 30:
        return float("nan"), float("nan"), len(x)
    xm, ym = x.mean(), y.mean()
    sxx = np.sum((x - xm) ** 2)
    b = np.sum((x - xm) * (y - ym)) / sxx
    e = (y - ym) - b * (x - xm)
    score = defaultdict(float)
    for xi, ei, g in zip(x - xm, e, groups):
        score[g] += xi * ei
    se = math.sqrt(sum(v * v for v in score.values())) / sxx
    return float(b), float(se), len(x)


def analyse(rows: list[dict], sport_of: dict) -> list[str]:
    ser = series(rows, sport_of)
    out = [f"games with a total on both DraftKings and Kalshi: {len(ser)}"]
    if not ser:
        return out + ["nothing to test yet: the engine has to have run with the Kalshi logging for a while"]
    for h in HORIZONS:
        steps = h // GRID_MIN
        gap, d_next, k_next, grp = [], [], [], []
        for gid, (grid, dk, ka) in ser.items():
            for i in range(0, len(grid) - steps):
                gap.append(ka[i] - dk[i])
                d_next.append(dk[i + steps] - dk[i])
                k_next.append(ka[i + steps] - ka[i])
                grp.append(gid)
        sl, sel, n = slope(gap, d_next, grp)
        sk, sek, _ = slope([-g for g in gap], k_next, grp)
        out.append(f"next {h:3d} min | DraftKings moves toward Kalshi: slope {sl:+.3f} (se {sel:.3f}) | Kalshi moves toward DraftKings: slope {sk:+.3f} (se {sek:.3f}) | n {n}")
    big = [(gid, ka[i] - dk[i]) for gid, (grid, dk, ka) in ser.items() for i in range(len(grid)) if abs(ka[i] - dk[i]) >= 1.5]
    out.append(f"moments with a gap of 1.5 points or more: {len(big)} in {len({g for g, _ in big})} games")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=3.0)
    ap.add_argument("--sport", default=None)
    a = ap.parse_args()
    from .store import SbStore

    st = SbStore()
    since = (datetime.now(timezone.utc) - timedelta(days=a.days)).isoformat()
    sport_of = {g["id"]: g["sport"] for g in st.rows("ex_games") if not a.sport or g["sport"] == a.sport}
    rows, last = [], since
    while True:
        q = st.c.table("ex_marks").select("ts,game_id,lines,r").gt("ts", last).order("ts").limit(1000)
        if a.sport:
            q = q.like("game_id", f"{a.sport}:%")
        page = q.execute().data
        if not page:
            break
        rows += [r for r in page if any(x[0] == "kal:total" for x in r["lines"])]
        last = page[-1]["ts"]
    print(f"{len(rows)} mark rows with a Kalshi total since {since[:16]}")
    for line in analyse(rows, sport_of):
        print(line)


if __name__ == "__main__":
    main()
