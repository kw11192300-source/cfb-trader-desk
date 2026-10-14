"""
Recruit rankings as the prior for freshmen: a first-year player with no college record is rated by where the recruiting
services ranked him, calibrated on the previous class - how the top-50 prospects of the class that just played actually rated
in their first college season (lineup-based rating, rating.py / rapm.py) and how much floor time they got.

    rating(rank)   = a + b * ln(rank)          fitted on last year's top 50 who played
    floor(rank)    = mean share of team floor time for that rank band

Unranked freshmen get the average of first-year players outside the top 50. recruits_{year}.csv hold the rankings
(247Sports composite top 50 with committed school) - refreshed by hand as classes sign.

Usage:
    python -m cbb_model.recruits calibrate
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .bpm import PLAYER_SEASONS_OUT, TARGETS_OUT, per40
from .ingest import DATA_DIR
from .overrides import norm

HERE = Path(__file__).resolve().parent
CALIBRATION_JSON = HERE / "recruit_calibration.json"


def load(year: int) -> pd.DataFrame:
    df = pd.read_csv(HERE / f"recruits_{year}.csv")
    df["key"] = df["name"].map(norm)
    return df


def calibrate(class_year: int = 2025) -> dict:
    """Fit on the class that played in season `class_year` (2025 = the 2025-26 season)."""
    from .players_table import player_values
    from .preseason import value_weights

    ps = pd.read_csv(PLAYER_SEASONS_OUT)
    tgt = pd.read_csv(TARGETS_OUT)
    ps40 = per40(ps)
    pv = player_values(ps40, value_weights(ps40, tgt, class_year + 1))
    post = DATA_DIR / "player_ratings_v2.csv"
    if post.exists():
        p = pd.read_csv(post).set_index("player_id")
        m = (pv["season"] == class_year) & pv["player_id"].isin(p.index)
        pv.loc[m, "v_off"] = pv.loc[m, "player_id"].map(p["off"]).to_numpy()
        pv.loc[m, "v_de"] = pv.loc[m, "player_id"].map(p["def"]).to_numpy()
        pv.loc[m, "v_net"] = pv.loc[m, "v_off"] - pv.loc[m, "v_de"]
    season = pv[pv["season"] == class_year].copy()
    season["key"] = season["name"].map(norm)
    seen_before = set(pv[pv["season"] < class_year]["player_id"])
    first_year = season[~season["player_id"].isin(seen_before)]

    rec = load(class_year)
    j = rec.merge(season[["key", "player_id", "v_net", "f", "min"]].drop_duplicates("key"), on="key", how="left")
    played = j[j["v_net"].notna() & (j["min"] >= 150)]
    print(f"class of {class_year}: {len(rec)} ranked, {int(j['v_net'].notna().sum())} found in last season's box scores, {len(played)} with 150+ minutes")

    x = np.log(played["rank"].to_numpy())
    X = np.c_[np.ones(len(x)), x]
    wts = np.sqrt(played["min"].to_numpy())
    beta = np.linalg.lstsq(X * wts[:, None], played["v_net"].to_numpy() * wts, rcond=None)[0]
    pred = X @ beta
    r2 = 1 - np.sum((played["v_net"] - pred) ** 2) / np.sum((played["v_net"] - played["v_net"].mean()) ** 2)
    print(f"rating = {beta[0]:+.2f} + {beta[1]:+.2f} * ln(rank)   R2 {r2:.2f}")

    bands = [(1, 5), (6, 15), (16, 30), (31, 50)]
    floor = {}
    for lo, hi in bands:
        b = played[(played["rank"] >= lo) & (played["rank"] <= hi)]
        floor[f"{lo}-{hi}"] = round(float(b["f"].mean()), 3) if len(b) else None
        print(f"  ranks {lo:>2}-{hi:<2}: n={len(b):>2}, mean rating {b['v_net'].mean():+.2f}, mean floor share {b['f'].mean():.2f}")
    ranked_keys = set(rec["key"])
    other = first_year[~first_year["key"].isin(ranked_keys) & (first_year["f"] >= 0.2)]
    unranked = {"rating": round(float(np.average(other["v_net"], weights=other["f"])), 2), "floor": round(float(other["f"].mean()), 3), "n": int(len(other))}
    print(f"unranked first-year players with real minutes: n={unranked['n']}, mean rating {unranked['rating']:+.2f}, mean floor share {unranked['floor']:.2f}")

    out = {"class_year": class_year, "a": round(float(beta[0]), 3), "b": round(float(beta[1]), 3), "r2": round(float(r2), 3), "floor_by_band": floor, "unranked": unranked}
    CALIBRATION_JSON.write_text(json.dumps(out, indent=1))
    return out


def prior(rank: int | None, cal: dict | None = None) -> tuple[float, float]:
    """(rating, floor share f) for a freshman of this recruit rank (None = unranked)."""
    cal = cal or json.loads(CALIBRATION_JSON.read_text())
    if rank is None:
        return float(cal["unranked"]["rating"]), float(cal["unranked"]["floor"])
    rating = cal["a"] + cal["b"] * float(np.log(rank))
    for band, f in cal["floor_by_band"].items():
        lo, hi = (int(x) for x in band.split("-"))
        if lo <= rank <= hi and f is not None:
            return float(rating), float(f)
    return float(rating), float(cal["unranked"]["floor"])


def recruit_extras(roster: pd.DataFrame, extras: pd.DataFrame, season: int, last_ids: set) -> tuple[pd.DataFrame, pd.DataFrame, list[str]]:
    """Rank-based freshman values for the class entering `season`. Returns (roster without those players - they are represented
    as extras instead -, the extras with the recruits appended, notes). A recruit already entered by hand in the overrides file
    keeps his manual number."""
    from .ingest import DATA_DIR as D

    names = pd.read_csv(D / "team_names.csv")
    key_to_team = {norm(s): int(i) for s, i in zip(names["school"], names["id"])}
    rec = load(season)
    cal = json.loads(CALIBRATION_JSON.read_text())
    manual = set(extras["name"].map(norm)) if len(extras) else set()
    rows, notes = [], []
    drop = []
    for r in rec.itertuples():
        tid = key_to_team.get(norm(r.school))
        if tid is None:
            notes.append(f"recruit {r.name}: unknown school {r.school}")
            continue
        if r.key in manual:
            continue
        on_roster = roster[(roster["team_id"] == tid) & (roster["name"].map(norm) == r.key)]
        if len(on_roster) and int(on_roster.iloc[0]["player_id"]) in last_ids:
            continue  # he already has college minutes (a returner who happens to be ranked): the box score decides
        rating, f = prior(int(r.rank), cal)
        rows.append({"team_id": tid, "f": f, "v_off": rating / 2.0, "v_de": -rating / 2.0, "name": r.name, "kind": "fr", "rank": int(r.rank)})
        drop.extend(on_roster.index.tolist())
    notes.append(f"{len(rows)} ranked freshmen priced from the recruiting rankings")
    add = pd.DataFrame(rows, columns=["team_id", "f", "v_off", "v_de", "name", "kind", "rank"])
    base = extras if len(extras) else pd.DataFrame(columns=["team_id", "f", "v_off", "v_de", "name", "kind", "rank"])
    return roster.drop(index=drop), pd.concat([base, add], ignore_index=True), notes


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["calibrate"])
    ap.parse_args()
    calibrate()


if __name__ == "__main__":
    main()
