"""Calibrates the exchange's opening line before DraftKings has priced a game (fitted by exchange/seed_fit.py, stored in exchange/seed_calib.json).

The rating systems that make the opening line are regressed toward the mean, so early in the season they squeeze a mismatch between a power-conference team and a small school to a third of
what DraftKings posts, and still squeeze close games to about half. The fix is a straight line from the exchange's margin to DraftKings' for each phase of the season and each tier distance between the two
teams (0 for two teams of the same tier, 1 for neighbouring tiers, 2 for A against C), mixed between phase centres so it does not step. College basketball only: other sports keep the raw line.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

PATH = Path(__file__).with_name("seed_calib.json")
CLIP = 45.0  # no opening margin beyond this
_CACHE: dict | None = None


def _cfg() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(PATH.read_text())
        except (OSError, ValueError):
            _CACHE = {}
    return _CACHE


def tier_distance(pair: str | None) -> int:
    """0 for AA, BB, CC; 1 for AB and BC; 2 for AC (the pair as exchange.engine writes it: the two tiers, strongest first)."""
    if not pair or len(pair) != 2 or any(c not in "ABC" for c in pair):
        return 1
    return abs("ABC".index(pair[0]) - "ABC".index(pair[1]))


def calibrate(sport: str, margin: float, total: float, game_day: date, pair: str | None) -> tuple[float, float]:
    """(margin, total) on DraftKings' scale for a game on `game_day`, or the raw numbers where nothing is fitted."""
    c = _cfg().get(sport)
    if not c or not c.get("phases"):
        return margin, total
    m0, d0 = c["anchor"]
    season = game_day.year if game_day >= date(game_day.year, 8, 1) else game_day.year - 1
    day = (game_day - date(season, m0, d0)).days
    ph = c["phases"]
    cs = [p["centre"] for p in ph]
    if day <= cs[0] or len(ph) == 1:
        mix = [(ph[0], 1.0)]
    elif day >= cs[-1]:
        mix = [(ph[-1], 1.0)]
    else:
        j = max(k for k, x in enumerate(cs) if x <= day)
        w1 = (day - cs[j]) / (cs[j + 1] - cs[j])
        mix = [(ph[j], 1 - w1), (ph[j + 1], w1)]
    d = str(tier_distance(pair))
    m = sum(w * (p["dist"][d][0] + p["dist"][d][1] * margin) for p, w in mix)
    return max(-CLIP, min(CLIP, m)), total  # the total is left as it is: its fitted line barely beat the raw total on later seasons and drifted its average error
