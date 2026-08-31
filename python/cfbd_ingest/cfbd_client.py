"""
Thin client for the CollegeFootballData.com API (https://collegefootballdata.com/).
Mirrors the shape of the TS client used by the sibling CFB Pick 'Em app
(../CFB Pick Em/src/lib/cfbd.ts) but covers the wider set of endpoints this
project's model needs: teams, season/game stats (regular + advanced), and
the four ratings systems (SP+, Elo, FPI, SRS).

Every function returns CFBD's raw JSON (list of dicts) — deliberately not
mapped into dataclasses, since most of it goes straight into JSONB columns
in Supabase and gets flattened with pandas at feature-build time instead.
"""
from __future__ import annotations

import time
from typing import Any

import requests

from .config import CFBD_API_KEY

CFBD_BASE = "https://api.collegefootballdata.com"


def _get(path: str, params: dict[str, Any] | None = None, retries: int = 3) -> Any:
    if not CFBD_API_KEY:
        raise RuntimeError("Missing CFBD_API_KEY environment variable.")

    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    headers = {"Authorization": f"Bearer {CFBD_API_KEY}"}

    last_error: Exception | None = None
    for attempt in range(retries):
        resp = requests.get(CFBD_BASE + path, params=clean_params, headers=headers, timeout=30)
        if resp.status_code == 429:
            # Rate limited — back off and retry rather than burn the request.
            time.sleep(2 ** attempt)
            continue
        if not resp.ok:
            last_error = RuntimeError(f"CFBD request to {path} failed: {resp.status_code} {resp.text[:500]}")
            break
        return resp.json()
    raise last_error or RuntimeError(f"CFBD request to {path} failed after {retries} retries (rate limited)")


def fetch_teams(classification: str | None = "fbs") -> list[dict]:
    return _get("/teams", {"classification": classification})


def fetch_games(
    year: int, season_type: str = "regular", week: int | None = None, classification: str | None = "fbs"
) -> list[dict]:
    """week=None returns the whole season in one call.

    classification="fbs" by default — otherwise CFBD returns every division's
    games (FCS, II, III included), which is not what a betting model wants.
    Pass None to get everything.
    """
    return _get("/games", {"year": year, "seasonType": season_type, "week": week, "classification": classification})


def fetch_lines(year: int, season_type: str = "regular", week: int | None = None) -> list[dict]:
    """week=None returns the whole season in one call."""
    return _get("/lines", {"year": year, "seasonType": season_type, "week": week})


def fetch_team_season_stats(year: int) -> list[dict]:
    """Regular per-category team season stats (rushing, passing, defense, ...)."""
    return _get("/stats/season", {"year": year})


def fetch_team_season_advanced_stats(year: int) -> list[dict]:
    """PPA, success rate, explosiveness, havoc — season-level, per team."""
    return _get("/stats/season/advanced", {"year": year})


def fetch_team_game_advanced_stats(year: int, week: int | None = None, season_type: str = "regular") -> list[dict]:
    """Per-game advanced stats. week=None returns the whole season."""
    return _get("/stats/game/advanced", {"year": year, "week": week, "seasonType": season_type})


def fetch_sp_ratings(year: int) -> list[dict]:
    return _get("/ratings/sp", {"year": year})


def fetch_elo_ratings(year: int, week: int | None = None) -> list[dict]:
    return _get("/ratings/elo", {"year": year, "week": week})


def fetch_fpi_ratings(year: int) -> list[dict]:
    return _get("/ratings/fpi", {"year": year})


def fetch_srs_ratings(year: int) -> list[dict]:
    return _get("/ratings/srs", {"year": year})
