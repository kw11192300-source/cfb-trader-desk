"""Turning a game's expected margin and total into prices for the whole ladder of lines, and DraftKings' posted lines into that
expected margin and total (so every contract has a market baseline, not only the one main line).

Football and basketball margins/totals are discrete normals (rounded to whole points); hockey uses independent Poissons for each
team's goals (so margins are Skellam), which keeps the low-scoring lines (2.5 ... 6.5, +/-1.5) honest.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from scipy.stats import norm, poisson, skellam

# (margin sd, total sd, league-average total) - the first two are the spread of an outcome around its expectation
SIGMA = {"nba": (12.9, 18.0, 225.0), "cbb": (11.3, 16.8, 142.0), "nfl": (13.2, 13.5, 45.0), "cfb": (14.0, 17.0, 55.0)}
HOCKEY_TOTAL = 6.0

FB_OFFS = [-6, -4, -2, -1, 0, 1, 2, 4, 6]
BB_TOTAL_OFFS = [-8, -5, -3, -1, 0, 1, 3, 5, 8]
HK_SPREADS = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]
HK_TOTAL_OFFS = [-2, -1, 0, 1, 2]


def prob(odds: float | None) -> float | None:
    """American odds -> implied probability (vig included)."""
    if odds is None or odds == 0:
        return None
    return 100.0 / (odds + 100.0) if odds > 0 else -odds / (-odds + 100.0)


def devig(a: float | None, b: float | None) -> float | None:
    """Fair probability of side A from both sides' American odds (proportional removal of the vig)."""
    pa, pb = prob(a), prob(b)
    if pa is None or pb is None:
        return None
    return pa / (pa + pb)


def clip(p: float, lo: float = 0.01, hi: float = 0.99) -> float:
    return min(hi, max(lo, p))


@dataclass
class Dist:
    sport: str
    m: float  # expected home margin
    t: float  # expected total

    # ---- P(margin > s) and P(margin < s) for a spread of -s on the home side ----
    def _win_lose_m(self, s: float) -> tuple[float, float]:
        k, c = math.floor(s), math.ceil(s) - 1
        if self.sport == "nhl":
            lh, la = max(0.2, (self.t + self.m) / 2), max(0.2, (self.t - self.m) / 2)
            return float(skellam.sf(k, lh, la)), float(skellam.cdf(c, lh, la))
        sd = SIGMA[self.sport][0]
        return float(1 - norm.cdf((k + 0.5 - self.m) / sd)), float(norm.cdf((c + 0.5 - self.m) / sd))

    def _win_lose_t(self, L: float) -> tuple[float, float]:
        k, c = math.floor(L), math.ceil(L) - 1
        if self.sport == "nhl":
            return float(poisson.sf(k, self.t)), float(poisson.cdf(c, self.t))
        sd = SIGMA[self.sport][1]
        return float(1 - norm.cdf((k + 0.5 - self.t) / sd)), float(norm.cdf((c + 0.5 - self.t) / sd))

    def p_spread(self, line: float) -> float:
        """Price of 'home covers at home line `line`' (home -3 is line -3). Refunded pushes make the fair price win/(win+lose)."""
        w, l = self._win_lose_m(-line)
        return clip(w / (w + l)) if w + l > 0 else 0.5

    def p_total(self, line: float) -> float:
        w, l = self._win_lose_t(line)
        return clip(w / (w + l)) if w + l > 0 else 0.5

    def p_ml(self) -> float:
        if self.sport == "nhl":
            lh, la = max(0.2, (self.t + self.m) / 2), max(0.2, (self.t - self.m) / 2)
            return clip(float(skellam.sf(0, lh, la) + 0.5 * skellam.pmf(0, lh, la)))
        w, _ = self._win_lose_m(0.0)
        return clip(w)

    def p(self, kind: str, line: float) -> float:
        return self.p_ml() if kind == "ml" else self.p_spread(line) if kind == "spread" else self.p_total(line)


def _bisect(f, lo: float, hi: float, target: float, n: int = 50) -> float:
    """f increasing in x; find x with f(x) = target."""
    for _ in range(n):
        mid = (lo + hi) / 2
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def fit(sport: str, snap: dict | None) -> tuple[Dist | None, float | None]:
    """DraftKings snapshot -> (Dist matching its spread/total, direct no-vig moneyline probability)."""
    if not snap:
        return None, None
    ml = devig(snap.get("ml_home"), snap.get("ml_away"))
    t_default = HOCKEY_TOTAL if sport == "nhl" else SIGMA[sport][2]
    t = t_default
    if snap.get("total") is not None:
        po = devig(snap.get("over"), snap.get("under"))
        po = 0.5 if po is None else clip(po, 0.03, 0.97)
        L = snap["total"]
        lo, hi = (0.5, 20.0) if sport == "nhl" else (t_default * 0.4, t_default * 1.8)
        t = _bisect(lambda x: Dist(sport, 0.0, x)._win_lose_t(L)[0] / sum(Dist(sport, 0.0, x)._win_lose_t(L)), lo, hi, po)
    span = 4.0 if sport == "nhl" else 45.0
    m = 0.0
    if snap.get("spread") is not None:
        pc = devig(snap.get("spread_home"), snap.get("spread_away"))
        if pc is not None:
            s = -snap["spread"]

            def f(x):
                w, l = Dist(sport, x, t)._win_lose_m(s)
                return w / (w + l)

            m = _bisect(f, -span, span, clip(pc, 0.03, 0.97))
    elif ml is not None:
        m = _bisect(lambda x: Dist(sport, x, t).p_ml(), -span, span, clip(ml, 0.03, 0.97))
    return Dist(sport, m, t), ml


def lines_for(sport: str, snap: dict | None) -> list[tuple[str, float]]:
    """The contracts offered on a game, anchored on whatever DraftKings has posted: moneyline, a ladder of spreads, a ladder of totals."""
    if not snap:
        return []
    out: list[tuple[str, float]] = []
    if snap.get("ml_home") is not None and snap.get("ml_away") is not None:
        out.append(("ml", 0.0))
    if snap.get("spread") is not None and snap.get("spread_home") is not None:
        if sport == "nhl":
            out += [("spread", x) for x in HK_SPREADS]
        else:
            out += [("spread", snap["spread"] + o) for o in FB_OFFS]
    if snap.get("total") is not None and snap.get("over") is not None:
        offs = HK_TOTAL_OFFS if sport == "nhl" else BB_TOTAL_OFFS if sport in ("nba", "cbb") else FB_OFFS
        out += [("total", snap["total"] + o) for o in offs if snap["total"] + o > 0]
    return out


def ckey(gid: str, kind: str, line: float) -> str:
    return f"{gid}|{kind}|{line:g}"


def label(kind: str, line: float, home: str, away: str) -> str:
    if kind == "ml":
        return f"{home} ML"
    if kind == "spread":
        return f"{home} {line:+g}"
    return f"Over {line:g}"


def outcome(kind: str, line: float, hs: int, as_: int) -> float:
    """1.0 if the contract's 'yes' side wins, 0.0 if it loses, 0.5 if it is a push (refund)."""
    if kind == "ml":
        return 0.5 if hs == as_ else float(hs > as_)
    v = (hs - as_ + line) if kind == "spread" else (hs + as_ - line)
    return 0.5 if v == 0 else float(v > 0)
