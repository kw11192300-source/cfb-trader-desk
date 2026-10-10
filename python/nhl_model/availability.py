"""
Which goalies are NOT available - so the model never counts on them.

Two sources:
  1. A manual list (table nhl_goalie_unavailable, set from the Goalies page): a goalie you know is out - ruled out for the
     season, or until a date - before ESPN's injury report catches up.
  2. ESPN's injury report: a goalie on injured reserve (or listed Out / suspended) is unavailable for games before his
     expected return date (day-to-day is NOT excluded - he may well play).

An unavailable goalie is dropped from the starter probabilities (the rest are renormalised), from the "who might play"
pool you can lock from, from ESPN's expected call (if ESPN names him anyway it is ignored), and from the goalie the season
simulation uses for a team. His rating and history are untouched - he just isn't an option.
"""
from __future__ import annotations

import re
import unicodedata

import pandas as pd
import requests

from .ingest import HEADERS

ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries"
OUT_WORDS = ("reserve", "out", "suspen")


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


class GoalieAvailability:
    def __init__(self, client, name_to_id: dict[str, float]):
        # manual list: goalie_id -> (until timestamp or None for the rest of the season, note)
        self.manual: dict[int, pd.Timestamp | None] = {}
        try:
            if client is not None:
                for r in client.table("nhl_goalie_unavailable").select("*").execute().data:
                    until = pd.Timestamp(r["until"], tz="UTC") if r.get("until") else None
                    self.manual[int(r["goalie_id"])] = until
        except Exception as e:  # noqa: BLE001 - optional table
            print(f"(no manual goalie availability list: {str(e)[:80]})")

        # ESPN injury report: goalie_id -> expected return (None = unknown, counted as out for now)
        self.espn: dict[int, pd.Timestamp | None] = {}
        try:
            data = requests.get(ESPN_INJURIES, headers=HEADERS, timeout=30).json()
            for t in data.get("injuries", []):
                for i in t.get("injuries", []):
                    if (i.get("athlete", {}).get("position", {}) or {}).get("abbreviation") != "G":
                        continue
                    status = (i.get("status") or "").lower()
                    if not any(w in status for w in OUT_WORDS):
                        continue
                    gid = name_to_id.get(_norm(i["athlete"]["displayName"]))
                    if gid is None:
                        continue
                    ret = (i.get("details") or {}).get("returnDate")
                    self.espn[int(gid)] = pd.Timestamp(ret, tz="UTC") if ret else None
        except Exception as e:  # noqa: BLE001
            print(f"(ESPN goalie injuries unavailable: {str(e)[:80]})")

    def out(self, goalie_id, start: pd.Timestamp) -> bool:
        """True if this goalie can't be expected to play a game starting at `start`."""
        if goalie_id is None or pd.isna(goalie_id):
            return False
        g = int(goalie_id)
        start = pd.Timestamp(start)
        if start.tzinfo is None:
            start = start.tz_localize("UTC")
        if g in self.manual:
            until = self.manual[g]
            if until is None or start < until:
                return True
        if g in self.espn:
            ret = self.espn[g]
            if ret is None or start.normalize() < ret:
                return True
        return False

    def summary(self) -> str:
        return f"{len(self.manual)} manual, {len(self.espn)} from ESPN's injury report"
