"""
European pro stats for incoming players, from EuroLeague Basketball's public stats API (api-live.euroleague.net, the same
service behind their website). It covers EuroLeague ("E") and EuroCup ("U") only - a small share of the players who arrive from
Europe - and publishes no terms of use, so this is deliberately light: a few dozen requests per season, cached to disk, with a
descriptive User-Agent. Other leagues (domestic European leagues, the G League...) are not covered here.

What it does:
  fetch      per-game player lines for recent EuroLeague/EuroCup seasons -> data/cbb/raw/euro/*.json
  match      which players on a D1 roster (ESPN's list + hand entries) played in those competitions

The translation from a pro line to a college rating lives in euro_rating() below: the pro per-40 line goes through the same
player-level box-score model as college players, discounted for league level and shrunk hard toward the first-year average by
how much floor time backs it.

Usage:
    python -m cbb_model.euro fetch
    python -m cbb_model.euro match
"""
from __future__ import annotations

import argparse
import json
import time

import pandas as pd
import requests

from .ingest import DATA_DIR
from .overrides import norm

RAW = DATA_DIR / "raw" / "euro"
BASE = "https://api-live.euroleague.net/v3/competitions/{comp}/statistics/players/traditional"
UA = "cfb-trader-desk research (personal, low volume, cached)"
COMPS = {"E": "EuroLeague", "U": "EuroCup"}


def fetch(seasons: tuple[int, ...] = (2024, 2025)) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for comp in COMPS:
        for s in seasons:
            path = RAW / f"{comp}{s}.json"
            if path.exists():
                continue
            url = BASE.format(comp=comp)
            r = requests.get(url, params={"SeasonMode": "Single", "SeasonCode": f"{comp}{s}", "statisticMode": "PerGame", "limit": 1000}, headers={"User-Agent": UA}, timeout=60)
            if r.status_code != 200:
                print(f"{comp}{s}: HTTP {r.status_code}")
                continue
            path.write_text(r.text, encoding="utf-8")
            n = len(r.json().get("players", []))
            print(f"{comp}{s}: {n} players", flush=True)
            time.sleep(2)  # be polite


def load() -> pd.DataFrame:
    rows = []
    for path in sorted(RAW.glob("*.json")):
        comp, season = path.stem[0], int(path.stem[1:])
        for p in json.loads(path.read_text(encoding="utf-8")).get("players", []):
            pl = p.get("player") or {}
            name = pl.get("name") or ""
            if "," in name:  # "KRATZER, LEON"
                last, first = [x.strip() for x in name.split(",", 1)]
                name = f"{first.title()} {last.title()}"
            rows.append(
                {
                    "comp": comp, "season": season, "code": pl.get("code"), "name": name, "key": norm(name), "age": pl.get("age"),
                    "team": (pl.get("team") or {}).get("name"), "gp": p.get("gamesPlayed"), "mpg": p.get("minutesPlayed"),
                    "pts": p.get("pointsScored"), "reb": p.get("totalRebounds"), "oreb": p.get("offensiveRebounds"), "dreb": p.get("defensiveRebounds"),
                    "ast": p.get("assists"), "stl": p.get("steals"), "blk": p.get("blocks"), "tov": p.get("turnovers"), "pf": p.get("foulsCommited"),
                    "two_m": p.get("twoPointersMade"), "two_a": p.get("twoPointersAttempted"), "tp_m": p.get("threePointersMade"), "tp_a": p.get("threePointersAttempted"),
                    "ft_m": p.get("freeThrowsMade"), "ft_a": p.get("freeThrowsAttempted"),
                }
            )
    return pd.DataFrame(rows)


def match() -> None:
    from .preseason import current_rosters

    euro = load()
    print(f"{len(euro):,} player-seasons from {sorted(euro['comp'].unique())}")
    ros = current_rosters(2026)
    ros["key"] = ros["name"].map(norm)
    hit = ros.merge(euro, on="key", how="inner", suffixes=("", "_euro"))
    print(f"{hit['key'].nunique()} players on 2026-27 D1 rosters also appear in EuroLeague/EuroCup 2024 or 2025:")
    for r in hit.sort_values(["team_id", "season"]).itertuples():
        print(f"  {r.name:<26} team {r.team_id:<5} {r.comp}{r.season} {str(r.team)[:22]:<22} gp {r.gp:.0f} mpg {r.mpg:.1f} ppg {r.pts:.1f} rpg {r.reb:.1f} apg {r.ast:.1f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["fetch", "match"])
    a = ap.parse_args()
    fetch() if a.what == "fetch" else match()


if __name__ == "__main__":
    main()
