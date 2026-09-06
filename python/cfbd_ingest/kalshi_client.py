"""
Thin client for Kalshi's public prediction-market API (kalshi.com) -
fully public, no API key or account needed for market DATA reads (unlike
placing orders, which needs OAuth2 - see docs.kalshi.com). Confirmed live
(Sept 2026) via direct requests, not assumed from docs.

Used for the college football full-game moneyline-equivalent market
(series KXNCAAFGAME): one binary "will X win?" market per team per game,
e.g. ticker "KXNCAAFGAME-26SEP19PURUCLA-UCLA". Real markets already exist
days ahead of kickoff (confirmed: a Week 3 game posted the same day this
was written).

Kalshi's own data does NOT reliably indicate which side is home vs away
(market order in the API response isn't consistent, and the ticker's
embedded team codes aren't reliably parseable) - group_by_event() returns
both sides unordered; sync_prediction_markets.py resolves home/away by
matching each side's team name against our OWN games table instead of
trusting Kalshi's ordering.
"""
from __future__ import annotations

import requests

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"


def fetch_ncaaf_game_markets() -> list[dict]:
    """Every OPEN market under the full-game-winner series, paginated via
    cursor. Two rows per game (one per team's own "yes" contract) -
    group_by_event() below combines them."""
    markets: list[dict] = []
    cursor: str | None = None
    while True:
        params: dict = {"series_ticker": "KXNCAAFGAME", "status": "open", "limit": 200}
        if cursor:
            params["cursor"] = cursor
        resp = requests.get(f"{KALSHI_BASE}/markets", params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        batch = data.get("markets", [])
        markets.extend(batch)
        cursor = data.get("cursor")
        if not cursor or not batch:
            break
    return markets


def group_by_event(markets: list[dict]) -> list[dict]:
    """Combines the two per-team markets for each game into one record:
    {id, commence_time, team_a, team_a_prob, team_b, team_b_prob, volume,
    liquidity}. Probabilities are the YES price in dollars (0-1 = implied
    probability directly, no conversion needed). Skips any event that
    doesn't have exactly two sides on file (shouldn't normally happen -
    a partial pair isn't safe to guess at)."""
    by_event: dict[str, dict] = {}
    for m in markets:
        event_ticker = m["event_ticker"]
        team = m.get("yes_sub_title") or m.get("title", "")
        rec = by_event.setdefault(event_ticker, {"commence_time": m.get("occurrence_datetime"), "sides": []})
        yes_price = m.get("yes_bid_dollars")
        rec["sides"].append(
            {
                "team": team,
                "prob": float(yes_price) if yes_price not in (None, "") else None,
                "volume": float(m.get("volume_fp") or 0),
                "liquidity": float(m.get("liquidity_dollars") or 0),
            }
        )

    out = []
    for event_ticker, rec in by_event.items():
        sides = rec["sides"]
        if len(sides) != 2:
            continue
        a, b = sides
        out.append(
            {
                "id": event_ticker,
                "commence_time": rec["commence_time"],
                "team_a": a["team"],
                "team_a_prob": a["prob"],
                "team_b": b["team"],
                "team_b_prob": b["prob"],
                "volume": a["volume"] + b["volume"],
                "liquidity": a["liquidity"] + b["liquidity"],
            }
        )
    return out
