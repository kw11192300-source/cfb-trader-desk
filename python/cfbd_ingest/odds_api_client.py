"""
Thin client for The Odds API (https://the-odds-api.com/) — a different
provider from CFBD, used specifically for real per-book juice/price
(-110, -105, etc.) and broader book coverage (FanDuel, BetMGM, Caesars,
BetRivers, ...) that CFBD's feed doesn't carry. CFBD remains the source of
truth for games/historical data/points; this only supplements current-week
pricing. See ../README.md for the credit-cost math behind polling cadence.
"""
from __future__ import annotations

from typing import Any

import requests

from .config import ODDS_API_KEY

ODDS_API_BASE = "https://api.the-odds-api.com/v4"



# "us" alone is standard licensed US books only (DraftKings, FanDuel, BetMGM,
# ...) - no genuinely sharp book among them. Pinnacle - confirmed live via a
# direct API call this session - only shows up under "eu". Cost is
# markets x regions per call (3 markets x 2 regions = 6 credits/call here,
# vs. 3 for "us" alone - see python/README.md's credit-cost tables before
# tightening sync-odds-api.yml's cadence on top of this).
# Set back to "us" until a cadence/tier decision is made - "us,eu" doubles
# the credit burn and the free tier's 500/mo can't cover it at the current
# polling cadence. Switch to "us,eu" to turn Pinnacle tracking on.
ODDS_API_REGIONS = "us"


def fetch_ncaaf_odds() -> tuple[list[dict], dict]:
    """Returns (events, usage) — usage has 'remaining' and 'used' credit counts
    from the response headers, useful for logging spend against the free tier."""
    if not ODDS_API_KEY:
        raise RuntimeError("Missing ODDS_API_KEY environment variable.")
    resp = requests.get(
        f"{ODDS_API_BASE}/sports/americanfootball_ncaaf/odds",
        params={
            "apiKey": ODDS_API_KEY,
            "regions": ODDS_API_REGIONS,
            "markets": "spreads,totals,h2h",
            "oddsFormat": "american",
        },
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Odds API request failed: {resp.status_code} {resp.text[:500]}")
    usage = {"remaining": resp.headers.get("x-requests-remaining"), "used": resp.headers.get("x-requests-used")}
    return resp.json(), usage
