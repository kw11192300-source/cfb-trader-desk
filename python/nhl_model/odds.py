"""
Flattens ESPN's cached core-odds responses (ingest.py) into one row per
(game, sportsbook) with open / close / current prices for the moneyline,
puck line and total, and builds the per-game market consensus the model is
judged against.

Coverage varies by era and it matters for what can be concluded:
  2022-23 on   open AND close blocks, many books through 2023-24, one or two
               (ESPN BET / DraftKings) after - real two-sided closing lines.
  2019-20 to 2021-22   only a `current` snapshot per book - for a completed
               game that's presumably the last captured line, but there's no
               way to confirm it's the true close, and some prices look like
               placeholders (totals priced exactly -110/-110). Treated as a
               weaker benchmark, flagged `era='snapshot'`.
  before 2019-20   nothing.
These are US retail books, not Pinnacle - a softer benchmark than a sharp
close (retail closing lines carry more margin and are a bit less efficient),
so beating them proves less than beating Pinnacle would.

Usage:
    python -m nhl_model.odds
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .ingest import DATA_DIR, ODDS_MAP_CSV, RAW_ODDS, read_gz

ODDS_OUT = DATA_DIR / "odds.csv.gz"


def _am(v) -> float | None:
    if isinstance(v, dict):
        v = v.get("american")
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().upper()
    if s in ("EVEN", "EV", "PK"):
        return 100.0
    try:
        return float(s.replace("+", ""))
    except ValueError:
        return None


def implied(american: float) -> float:
    return 100.0 / (american + 100.0) if american > 0 else -american / (-american + 100.0)


def devig2(a: float, b: float) -> float:
    """Fair probability of side A from both sides' American prices."""
    pa, pb = implied(a), implied(b)
    return pa / (pa + pb)


def _side(odds: dict, stage: str):
    st = odds.get(stage) or {}
    ml, pts, price = _am(st.get("moneyLine")), _am(st.get("pointSpread")), _am(st.get("spread"))
    if stage == "current" and ml is None:
        ml, price = _am(odds.get("moneyLine")), _am(odds.get("spreadOdds"))
    return ml, pts, price


def _total(item: dict, stage: str):
    st = item.get(stage) or {}
    tot, over, under = _am(st.get("total")), _am(st.get("over")), _am(st.get("under"))
    if stage == "current" and tot is None:
        tot, over, under = _am(item.get("overUnder")), _am(item.get("overOdds")), _am(item.get("underOdds"))
    return tot, over, under


def parse_item(item: dict) -> dict | None:
    name = (item.get("provider") or {}).get("name") or ""
    if "live" in name.lower():
        return None
    home, away = item.get("homeTeamOdds") or {}, item.get("awayTeamOdds") or {}
    row = {"provider": name}
    for stage in ("open", "close", "current"):
        k = {"current": "cur"}.get(stage, stage)
        hm, hp, hpr = _side(home, stage)
        am_, ap, apr = _side(away, stage)
        tot, over, under = _total(item, stage)
        row.update({f"ml_home_{k}": hm, f"ml_away_{k}": am_, f"pl_home_{k}": hp, f"pl_home_price_{k}": hpr, f"pl_away_price_{k}": apr,
                    f"total_{k}": tot, f"over_{k}": over, f"under_{k}": under})
    return row


def run() -> None:
    mp = pd.read_csv(ODDS_MAP_CSV)
    rows = []
    for r in mp.itertuples():
        path = RAW_ODDS / str(r.season) / f"{r.espn_id}.json.gz"
        if not path.exists():
            continue
        for item in read_gz(path).get("items", []):
            row = parse_item(item)
            if row:
                row.update(game_id=r.game_id, season=r.season, espn_id=r.espn_id)
                rows.append(row)
    df = pd.DataFrame(rows)
    df["era"] = np.where(df["ml_home_close"].notna() & df["ml_away_close"].notna(), "close", "snapshot")
    df.to_csv(ODDS_OUT, index=False)
    print(f"{len(df):,} (game, book) rows over {df['game_id'].nunique():,} games -> {ODDS_OUT}")
    print(df.groupby(["season", "era"]).agg(games=("game_id", "nunique"), books=("provider", "nunique")).to_string())


def market_consensus(odds: pd.DataFrame) -> pd.DataFrame:
    """One row per game: mean de-vigged home-win probability across books -
    the CLOSE where a book has one, else its `current` snapshot - plus the
    book count and which era it came from."""
    o = odds.copy()
    o["is_close"] = o["ml_home_close"].notna() & o["ml_away_close"].notna()
    o["ml_h"] = np.where(o["is_close"], o["ml_home_close"], o["ml_home_cur"])
    o["ml_a"] = np.where(o["is_close"], o["ml_away_close"], o["ml_away_cur"])
    o = o[o["ml_h"].notna() & o["ml_a"].notna()].copy()
    # A game with ANY true close uses only those; averaging one real closing
    # line with fifteen unconfirmed snapshots would dilute the benchmark.
    has_close = o.groupby("game_id")["is_close"].transform("any")
    o = o[~has_close | o["is_close"]].copy()
    o["p_home_fair"] = [devig2(h, a) for h, a in zip(o["ml_h"], o["ml_a"])]
    return (
        o.groupby("game_id")
        .agg(mkt_p_home=("p_home_fair", "mean"), n_books=("provider", "nunique"), era=("is_close", lambda s: "close" if s.any() else "snapshot"), season=("season", "first"))
        .reset_index()
    )


if __name__ == "__main__":
    run()
