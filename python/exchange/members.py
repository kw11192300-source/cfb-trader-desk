"""The roster: eight syndicates with 10,000 units each, split into five sport desks of 2,000.

Every trader has the same goal (beat the closing DraftKings price, which in the long run is the same as making money) and works inside the
same rulebook; each builds its own strategy inside it:

  rulebook   (engine.RULES) fair price is DraftKings' no-vig price nudged toward the syndicate's model by a weight the syndicate learns
             from settled games, and never more than 12 cents from DraftKings; at most 100 units (1% of the syndicate's bankroll) on one game
             and market type; quarter Kelly at most; at most 70% of a desk's bankroll tied up; never both sides of the same line;
             a trader asks for at least a 1-cent edge and quotes at least 1 cent each side
  strategy   (per trader) how big an edge it demands, how tight it quotes, how hard it bets, how far it trusts its syndicate's model - set at
             the start, then reviewed from its own results: takes that close worse than they were paid raise the edge it demands, quotes that
             get picked off widen, and good results tighten it up
A contract pays 1 unit, so a 40-cent contract bought 100 times risks 40 units.
"""
from __future__ import annotations

import random

SYNDICATE_UNITS = 10_000.0
DESK_SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"]
DESK_UNITS = SYNDICATE_UNITS / len(DESK_SPORTS)

def strategy(sid: str, sport: str) -> dict:
    """Each trader starts with its own take on the shared rulebook - how big an edge it wants, how tight it quotes, how hard it bets, how far it
    trusts its syndicate's model - and then adapts it from its own results (engine.adapt). The rulebook itself (engine.RULES) caps all of it."""
    r = random.Random(f"{sid}-{sport}")
    return dict(max_risk=100.0, thr=round(r.uniform(0.012, 0.03), 3), half=round(r.uniform(0.01, 0.025), 3), kelly=round(r.uniform(0.1, 0.25), 2),
                size=round(r.uniform(60, 100)), skew=round(r.uniform(0.0001, 0.0004), 5), trust=round(r.uniform(0.7, 1.3), 2))


SYNDICATES = [
    dict(id="elo", name="Elo Works", engine="elo", color="#2563eb", tagline="Margin Elo: every result moves a team's rating, the off-season pulls it back toward average."),
    dict(id="ridge", name="Ridge Rangers", engine="ridge_long", color="#7c3aed", tagline="Offence/defence ridge regression with a long memory - the slow, stable view of team quality."),
    dict(id="form", name="Form Guide", engine="ridge_short", color="#ea580c", tagline="The same regression with a short memory: who is hot or cold right now."),
    dict(id="blend", name="Consensus Desk", engine="blend", color="#059669", tagline="Averages the three rating systems, so it only disagrees with the market when they all do."),
    dict(id="tape", name="Tape Readers", engine="tape", color="#0891b2", tagline="No ratings: follows DraftKings line movement and bets that steam keeps going."),
    dict(id="fade", name="Fade Club", engine="fade", color="#dc2626", tagline="No ratings: bets that big line moves overshoot and fade them."),
    dict(id="pace", name="Pace Lab", engine="pace", color="#ca8a04", tagline="Totals specialists - scoring environment from the ratings, with no view on sides."),
    dict(id="mm", name="Liquidity Partners", engine="ref", color="#475569", tagline="The control group: no model at all, so they quote and trade straight off the DraftKings price."),
]


def roster() -> tuple[list[dict], list[dict]]:
    syns, mems = [], []
    for s in SYNDICATES:
        syns.append({"id": s["id"], "name": s["name"], "engine": s["engine"], "color": s["color"], "tagline": s["tagline"],
                     "start_units": SYNDICATE_UNITS, "learn": {}})
        for sp in DESK_SPORTS:
            params = {**strategy(s["id"], sp), "sports": [sp]}
            if s["id"] == "pace":
                params["kinds"] = ["total"]
            mems.append({"id": f"{s['id']}-{sp}", "syndicate_id": s["id"], "name": f"{sp.upper()} desk", "role": "both", "staking": "kelly",
                         "params": params, "start_units": DESK_UNITS, "cash": DESK_UNITS, "locked": 0.0, "realized": 0.0,
                         "stats": {"n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0,
                                   "clv_sum": 0.0, "clv_n": 0, "peak": DESK_UNITS, "max_dd": 0.0, "wins": 0, "losses": 0, "biggest": 0.0}})
    return syns, mems
