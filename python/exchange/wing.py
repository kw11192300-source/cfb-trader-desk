"""The Wing Desk's prices for alternate lines.

DraftKings posts one number on each market, and the exchange prices every other line on the ladder from a normal curve fitted to it, with a width that is fixed per sport
(pricing.SIGMA). The Wing Desk keeps DraftKings' price on the main line and only changes how fast the price moves away from it: with a width that depends on the game
(wing_fit.py fits it from past games), so a 30-point favourite or a 170-point total gets a wider curve than a close, slow game. In z-score terms, the engine's price for an
alternate line sits z standard deviations from the anchor's; the desk's sits z * (engine width / game width) from it.

It also sets how wide to quote: further from the main number is less certain and thinner, so the half-spread grows with the distance, and quotes shrink with it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from scipy.stats import norm

from . import pricing

PATH = Path(__file__).with_name("wing_sigma.json")
RHO_LO, RHO_HI = 0.85, 1.20  # the desk never moves a price by more than the width ratio allows: a bad fit cannot move quotes far
HALF_PER_POINT = 0.0035  # extra half-spread per point of distance from the main number (the main line is quoted by everyone else; out here the desk is the market)
HALF_PER_SD = 0.012  # ...and per standard deviation of distance, so a six-point wing in football and a three-point wing in basketball are treated alike
EX_WEIGHT = 0.5  # how far toward the exchange's own main-line price the desk moves its anchor from DraftKings': sharps mostly hit the main lines, so that is where the exchange learns first
EX_MAX = 0.04  # ...never more than this many cents
PRESSURE_WIDEN = 0.03  # extra half-spread, at full pressure, on every wing line of a game that sharp flow is moving (full pressure is PRESSURE_FULL standard deviations of shift)
PRESSURE_FULL = 0.10
PULL_AT = 0.17  # past this much shift (the flow cap is 0.2) the desk takes its wing quotes off that game until the pressure fades
SIZE_DECAY = 0.12  # quote size falls this much per standard deviation from the main number
WING_SPORTS = ("nfl", "cfb", "nba", "cbb")  # not hockey: its ladder is narrow and low-scoring, with no alternate lines to speak of
_CACHE: dict | None = None


def _params() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(PATH.read_text())
        except (OSError, ValueError):
            _CACHE = {}
    return _CACHE


def width(sport: str, kind: str, spread: float | None, total: float | None) -> float:
    """How wide the spread of results is around this game's main line: the fitted curve where there is one, else the engine's fixed width."""
    sg = pricing.SIGMA.get(sport)
    if not sg:
        return 1.0
    base = sg[0] if kind == "spread" else sg[1]
    fit = (_params().get(sport) or {}).get("m" if kind == "spread" else "t")
    if not fit or not fit.get("use"):
        return base
    if kind == "spread" and spread is not None:
        return math.exp(fit["a"] + fit["b"] * min(abs(spread), fit["cap"]) / 10.0)
    if kind == "total" and total is not None and total > 0:
        return math.exp(fit["a"] + fit["b"] * math.log(total / fit["ref"]))
    return base


def rho(sport: str, kind: str, spread: float | None, total: float | None) -> float:
    """Engine width over the game's own width: below 1 pulls alternate prices toward the main line's, above 1 pushes them away."""
    sg = pricing.SIGMA.get(sport)
    if not sg:
        return 1.0
    base = sg[0] if kind == "spread" else sg[1]
    return min(RHO_HI, max(RHO_LO, base / width(sport, kind, spread, total)))


def anchor(p_dk: float, p_ex: float | None) -> float:
    """The main-line price the desk builds from: DraftKings', moved part of the way toward what the exchange has learned."""
    return p_dk if p_ex is None else p_dk + max(-EX_MAX, min(EX_MAX, EX_WEIGHT * (p_ex - p_dk)))


def alt_price(p: float, p_anchor: float, r: float, center: float | None = None) -> float:
    """The desk's price for an alternate line, from the engine's price p for it and the engine's price p_anchor for the nearest main line; `center` moves the anchor itself."""
    q0, q = norm.ppf(min(0.99, max(0.01, p_anchor))), norm.ppf(min(0.99, max(0.01, p)))
    qc = q0 if center is None else norm.ppf(min(0.99, max(0.01, center)))
    return float(min(0.99, max(0.01, norm.cdf(qc + (q - q0) * r))))


def pressure_widen(pressure: float) -> float:
    """Extra half-spread when sharp flow has moved the game: `pressure` is the shift in standard deviations."""
    return PRESSURE_WIDEN * min(1.0, pressure / PRESSURE_FULL)


def half_extra(off_points: float, sd: float) -> float:
    """Extra half-spread for a line this many points from the main number."""
    return HALF_PER_POINT * off_points + HALF_PER_SD * off_points / max(1.0, sd)


def size_factor(off_points: float, sd: float) -> float:
    return max(0.35, 1.0 - SIZE_DECAY * off_points / max(1.0, sd) * 3.0)
