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
CBB_OFFS = [-3, -2, -1, 0, 1, 2, 3]  # college basketball: seven lines either side of the main number, one point apart, so there is little to move when the line does
HK_SPREADS = [-2.5, -1.5, 1.5, 2.5]  # +-0.5 are left out: with no ties they are the same event as the moneyline
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
            w, l = float(skellam.sf(k, lh, la)), float(skellam.cdf(c, lh, la))
            # a game level after 60 minutes is settled by overtime or a shootout, and the official final score gives the winner one goal: a tie
            # becomes a one-goal win for either side, half each. So "home -0.5" and "home +0.5" are both just "home wins", the same event as the moneyline.
            t = 0.5 * float(skellam.pmf(0, lh, la))
            w += t if k == 0 else -t if k == -1 else 0.0
            l += t if c == -1 else -t if c == 0 else 0.0
            return w, l
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


def main_half(line: float | None) -> float | None:
    """The half-point line standing in for a main line: itself if it already ends in .5, else half a point toward the home side's favour."""
    return None if line is None else line if line % 1 else line + 0.5


def ladder(base: float, offsets: list[float]) -> list[float]:
    """Lines around a main number, every one ending in .5 so no contract can push. A whole-number main gets the half-points either side of it."""
    if base % 1:
        return [base + o for o in offsets]
    return sorted({base + o + 0.5 for o in offsets} | {base - 0.5})


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
            out += [("spread", x) for x in ladder(snap["spread"], CBB_OFFS if sport == "cbb" else FB_OFFS) if abs(x) != 0.5]  # no ties: +-0.5 is just the moneyline
    if snap.get("total") is not None and snap.get("over") is not None:
        offs = HK_TOTAL_OFFS if sport == "nhl" else CBB_OFFS if sport == "cbb" else BB_TOTAL_OFFS if sport == "nba" else FB_OFFS
        out += [("total", x) for x in ladder(snap["total"], offs) if x > 0]
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


def american(p: float) -> float:
    p = clip(p, 0.02, 0.98)
    return float(round(-100 * p / (1 - p)) if p >= 0.5 else round(100 * (1 - p) / p))


def _half(x: float) -> float:
    """The half-point line nearest x."""
    return float(round(x - 0.5) + 0.5)


def synth_snap(sport: str, m: float, t: float, ml_p: float | None = None) -> dict:
    """A DraftKings-shaped snapshot built from an expected margin and total, for games that have no posted line yet."""
    d = Dist(sport, m, t)
    sl, tl = _half(-m), _half(t)
    ps, po, pm = d.p_spread(sl), d.p_total(tl), ml_p if ml_p is not None else d.p_ml()
    return {"spread": sl, "spread_home": american(ps), "spread_away": american(1 - ps), "total": tl, "over": american(po), "under": american(1 - po),
            "ml_home": american(pm), "ml_away": american(1 - pm)}


def fit_from_probs(sport: str, spread_pts: list[tuple[float, float]], total_pts: list[tuple[float, float]], ml_p: float | None = None) -> tuple[float, float] | None:
    """(expected margin, expected total) that best reproduces a set of spread prices (home covers at line), total prices (over at line) and a moneyline."""
    from scipy.optimize import minimize_scalar

    t_default = HOCKEY_TOTAL if sport == "nhl" else SIGMA[sport][2]
    t = t_default
    if total_pts:
        lo, hi = (0.5, 20.0) if sport == "nhl" else (t_default * 0.4, t_default * 1.8)
        t = float(minimize_scalar(lambda x: sum((Dist(sport, 0.0, x).p_total(L) - p) ** 2 for L, p in total_pts), bounds=(lo, hi), method="bounded").x)
    span = 4.0 if sport == "nhl" else 45.0
    if spread_pts:
        m = float(minimize_scalar(lambda x: sum((Dist(sport, x, t).p_spread(L) - p) ** 2 for L, p in spread_pts), bounds=(-span, span), method="bounded").x)
    elif ml_p is not None:
        m = _bisect(lambda x: Dist(sport, x, t).p_ml(), -span, span, clip(ml_p, 0.03, 0.97))
    elif total_pts:
        m = 0.0
    else:
        return None
    return m, t
