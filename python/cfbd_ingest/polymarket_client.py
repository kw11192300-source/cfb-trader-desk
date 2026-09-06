"""
Thin client for Polymarket's public Gamma API (polymarket.com) - fully
public, no API key or wallet needed for market DATA reads (unlike placing
orders, which needs a funded Polygon wallet). Confirmed live (Sept 2026)
via direct requests: comprehensive per-game coverage, down to small-
school matchups, not just championship/futures markets.

Used for the "CFB" tag (id 100351, found via /tags and /series - not
documented, discovered by direct API inspection). Each real game is one
event with a single two-outcome market (e.g. "Oklahoma vs. Michigan",
outcomes ["Oklahoma","Michigan"], outcomePrices ["0.655","0.345"]) -
unlike Kalshi's two-separate-binary-markets shape.
"""
from __future__ import annotations

import json

import requests

GAMMA_BASE = "https://gamma-api.polymarket.com"
CFB_TAG_ID = 100351
PAGE_SIZE = 100


def fetch_ncaaf_events() -> list[dict]:
    """Every open event under the CFB tag, paginated via offset. Includes
    futures/props alongside real games - callers filter for the actual
    per-game shape (see normalize_game_events)."""
    events: list[dict] = []
    offset = 0
    while True:
        resp = requests.get(
            f"{GAMMA_BASE}/events", params={"tag_id": CFB_TAG_ID, "closed": "false", "limit": PAGE_SIZE, "offset": offset}, timeout=30
        )
        resp.raise_for_status()
        batch = resp.json()
        events.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return events


def normalize_game_events(events: list[dict]) -> list[dict]:
    """Filters to actual two-team game markets (title contains " vs. " and
    has a real kickoff time) and reshapes into {id, commence_time,
    team_a, team_a_prob, team_b, team_b_prob, volume, liquidity} - same
    shape as kalshi_client.group_by_event, so sync_prediction_markets.py
    can treat both sources identically."""
    out = []
    for e in events:
        title = e.get("title", "")
        if " vs. " not in title:
            continue
        markets = e.get("markets") or []
        if not markets:
            continue
        m = markets[0]
        kickoff = m.get("gameStartTime")
        if not kickoff:
            continue
        try:
            outcomes = json.loads(m.get("outcomes", "[]"))
            prices = json.loads(m.get("outcomePrices", "[]"))
        except (json.JSONDecodeError, TypeError):
            continue
        if len(outcomes) != 2 or len(prices) != 2:
            continue
        out.append(
            {
                "id": e["id"],
                "commence_time": kickoff,
                "team_a": outcomes[0],
                "team_a_prob": float(prices[0]),
                "team_b": outcomes[1],
                "team_b_prob": float(prices[1]),
                "volume": float(m.get("volume") or 0),
                "liquidity": float(m.get("liquidity") or 0),
            }
        )
    return out
