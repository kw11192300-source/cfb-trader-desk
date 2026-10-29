"""The roster: eight syndicates, five members each, 200 units per member (1,000 per syndicate).

A syndicate is a rating system (what it believes a fair price is); its members are traders with different jobs and staking plans:
  makers  post a bid and an ask around their fair price and wait to be hit
  takers  hit someone else's quote when it is off from their fair price by more than a threshold
  ref_w   how much of the DraftKings baseline goes into their fair price (0 = bottom-up, only their own ratings; 1 = top-down, the market)
  staking flat / kelly (fraction of full Kelly) / pct (share of bankroll) / edge (scales with the edge) - every trade capped at max_risk
"""
from __future__ import annotations

START_UNITS = 200.0
MAX_RISK = 8.0  # units risked on one trade; a hard stop under the 5-10 guidance

SYNDICATES = [
    dict(id="elo", name="Elo Works", engine="elo", color="#2563eb", tagline="Margin Elo: every result moves a team's rating, the off-season pulls it back toward average."),
    dict(id="ridge", name="Ridge Rangers", engine="ridge_long", color="#7c3aed", tagline="Offence/defence ridge regression with a long memory - the slow, stable view of team quality."),
    dict(id="form", name="Form Guide", engine="ridge_short", color="#ea580c", tagline="The same regression with a short memory: who is hot or cold right now."),
    dict(id="blend", name="Consensus Desk", engine="blend", color="#059669", tagline="Averages the three rating systems, so it only disagrees with the market when they all do."),
    dict(id="tape", name="Tape Readers", engine="tape", color="#0891b2", tagline="No ratings: follows DraftKings line movement and bets that steam keeps going."),
    dict(id="fade", name="Fade Club", engine="fade", color="#dc2626", tagline="No ratings: bets that big line moves overshoot and fade them."),
    dict(id="pace", name="Pace Lab", engine="pace", color="#ca8a04", tagline="Totals specialists - scoring environment from the ratings, with no view on sides."),
    dict(id="mm", name="Liquidity Partners", engine="ref", color="#475569", tagline="Pure market makers: quote tight around the DraftKings price and earn the spread."),
]

TRADER_TYPES = [
    dict(key="flat", name="Flat Taker", role="taker", staking="flat", flat=3.0, ref_w=0.3, thr=0.03),
    dict(key="kelly", name="Kelly Bottom-Up", role="taker", staking="kelly", kelly=0.25, ref_w=0.0, thr=0.04),
    dict(key="ev", name="+EV Hunter", role="taker", staking="edge", ref_w=0.5, thr=0.02),
    dict(key="quote", name="Quoter", role="maker", staking="pct", pct=0.02, ref_w=0.5, half=0.025, size=12.0, skew=0.002),
    dict(key="dual", name="Two-Way", role="both", staking="kelly", kelly=0.15, ref_w=0.25, thr=0.035, half=0.035, size=8.0, skew=0.003),
]
MM_TYPES = [
    dict(key="tight", name="Tight Quoter", role="maker", staking="pct", pct=0.02, ref_w=1.0, half=0.012, size=10.0, skew=0.004),
    dict(key="mid", name="Mid Quoter", role="maker", staking="pct", pct=0.02, ref_w=1.0, half=0.022, size=16.0, skew=0.003),
    dict(key="wide", name="Wide Quoter", role="maker", staking="pct", pct=0.02, ref_w=1.0, half=0.04, size=30.0, skew=0.002),
    dict(key="skew", name="Inventory Skewer", role="maker", staking="pct", pct=0.02, ref_w=1.0, half=0.02, size=14.0, skew=0.01),
    dict(key="lean", name="Lean Quoter", role="both", staking="flat", flat=2.0, ref_w=0.85, thr=0.05, half=0.025, size=10.0, skew=0.004),
]


def roster() -> tuple[list[dict], list[dict]]:
    syns, mems = [], []
    for s in SYNDICATES:
        types = MM_TYPES if s["id"] == "mm" else TRADER_TYPES
        syns.append({"id": s["id"], "name": s["name"], "engine": s["engine"], "color": s["color"], "tagline": s["tagline"], "start_units": START_UNITS * len(types)})
        for t in types:
            params = {k: v for k, v in t.items() if k not in ("key", "name", "role", "staking")}
            params.update(max_risk=MAX_RISK)
            if s["id"] == "pace":
                params["kinds"] = ["total"]
            mems.append({"id": f"{s['id']}-{t['key']}", "syndicate_id": s["id"], "name": t["name"], "role": t["role"], "staking": t["staking"],
                         "params": params, "start_units": START_UNITS, "cash": START_UNITS, "locked": 0.0, "realized": 0.0,
                         "stats": {"n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0,
                                   "clv_sum": 0.0, "clv_n": 0, "peak": START_UNITS, "max_dd": 0.0, "wins": 0, "losses": 0, "biggest": 0.0}})
    return syns, mems
