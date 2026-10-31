"""College basketball conference tiers, for limits: a game between two power-conference teams carries a bigger limit than one between two small-conference teams.

  A  the six power conferences (ACC, Big Ten, Big 12, SEC, Big East)
  B  the top mid-majors (Atlantic 10, American, Mountain West, West Coast, Missouri Valley)
  C  everyone else, and any team not in the list

Built from the conference table in python/data/cbb (the latest season there) and stored in ex_ratings as "cbb|tiers", so the hosted rounds can read it. Rebuild with `python -m exchange tiers`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

A = {"Atlantic Coast Conference", "Big Ten Conference", "Big 12 Conference", "Southeastern Conference", "Big East Conference", "Pac-12 Conference"}
B = {"Atlantic 10 Conference", "American Conference", "Mountain West Conference", "West Coast Conference", "Missouri Valley Conference"}
CSV = Path(__file__).resolve().parents[1] / "data" / "cbb" / "conferences.csv"


def build(store) -> int:
    c = pd.read_csv(CSV)
    latest = c[c["season"] == c["season"].max()]
    tiers = {str(r.team_id): ("A" if r.conference in A else "B" if r.conference in B else "C") for r in latest.itertuples()}
    store.upsert("ex_ratings", [{"key": "cbb|tiers", "payload": {"tiers": tiers, "season": int(c["season"].max())}, "fitted_at": datetime.now(timezone.utc).isoformat()}])
    return len(tiers)


def mult(tier: str, hours: float) -> float:
    """The factor on a college basketball game's limit from the two teams' tiers: bigger for the biggest games, smaller early in the week for the smallest, and all of them at full size by three hours out."""
    p = min(1.0, max(0.0, (24.0 - hours) / 21.0))  # 0 a day out, 1 at three hours: the smaller games catch up to full size by then
    if tier == "AA":
        return 1.5 if hours <= 12 else 1.25
    if tier in ("AB", "BB", "AC"):
        return 1.0
    if tier == "BC":
        return 0.8 + 0.2 * p
    return 0.5 + 0.5 * p  # two small-conference teams: half size early in the week, full size from three hours out
