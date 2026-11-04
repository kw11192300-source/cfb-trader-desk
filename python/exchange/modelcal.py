"""Puts each rating model on the market's scale at run time (fitted by exchange/modelcal_fit.py, stored in exchange/model_calib.json).

A model that is regressed toward the mean looks bearish on every big favourite. Calibrated, its margin means what a DraftKings margin means, so what is left of its difference from the market is opinion.
Straight line per phase of the season (mixed between phase centres) and, for college basketball, per tier distance between the two teams. A model with no fitted line is returned as it came.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

PATH = Path(__file__).with_name("model_calib.json")
CLIP = 45.0
_CACHE: dict | None = None


def _cfg() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(PATH.read_text())
        except (OSError, ValueError):
            _CACHE = {}
    return _CACHE


def tier_pair(rat: dict, home_id: str, away_id: str) -> str:
    ct = (rat.get("cbb|tiers") or {}).get("tiers", {})
    return "".join(sorted([ct.get(str(home_id), "C"), ct.get(str(away_id), "C")]))


def _dist(pair: str | None) -> int:
    if not pair or len(pair) != 2 or any(c not in "ABC" for c in pair):
        return 1
    return abs("ABC".index(pair[0]) - "ABC".index(pair[1]))


def calibrated(sport: str, engine: str) -> bool:
    c = ((_cfg().get(sport) or {}).get("engines") or {}).get(engine)
    return bool(c and c.get("use"))


def calibrate(sport: str, engine: str, margin: float, total: float, game_day: date, pair: str | None) -> tuple[float, float]:
    cfg = _cfg().get(sport)
    c = ((cfg or {}).get("engines") or {}).get(engine)
    if not c or not c.get("use"):
        return margin, total
    m0, d0 = cfg["anchor"]
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
    d = str(_dist(pair)) if cfg.get("tiers") else "0"
    m = sum(w * (p["dist"][d][0] + p["dist"][d][1] * margin) for p, w in mix)
    t = sum(w * (p["total"][0] * total + p["total"][1]) for p, w in mix) if c.get("use_total") else total
    return max(-CLIP, min(CLIP, m)), t
