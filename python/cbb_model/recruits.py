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

    # rank bands, each with its average first-season rating and floor share; a recruit's prior interpolates between band
    # centres on a log-rank scale (flat beyond the ends) instead of extrapolating a fitted line to the #1 recruit
    bands = [(1, 5), (6, 15), (16, 30), (31, 50), (51, 100), (101, 200)]
    out_bands = []
    for lo, hi in bands:
        b = played[(played["rank"] >= lo) & (played["rank"] <= hi)]
        if len(b) < 3:
            continue
        w = b["min"].to_numpy()
        out_bands.append(
            {
                "lo": lo, "hi": hi, "center": round(float(np.log(np.sqrt(lo * hi))), 4), "n": int(len(b)),
                "rating": round(float(np.average(b["v_net"], weights=w)), 2), "floor": round(float(np.average(b["f"], weights=w)), 3),
                "rating_sd": round(float(b["v_net"].std()), 2),
            }
        )
        print(f"  ranks {lo:>3}-{hi:<3}: n={len(b):>2}, mean rating {out_bands[-1]['rating']:+.2f} (sd {out_bands[-1]['rating_sd']:.1f}), mean floor share {out_bands[-1]['floor']:.2f}")
    # a better recruit can't be worth less on average: pool adjacent bands that break the order (sample noise)
    def pav(values: list[float], weights: list[float]) -> list[float]:
        blocks = [[v, w, 1] for v, w in zip(values, weights)]
        i = 0
        while i < len(blocks) - 1:
            if blocks[i][0] < blocks[i + 1][0] - 1e-12:  # must be non-increasing with rank
                v = (blocks[i][0] * blocks[i][1] + blocks[i + 1][0] * blocks[i + 1][1]) / (blocks[i][1] + blocks[i + 1][1])
                blocks[i : i + 2] = [[v, blocks[i][1] + blocks[i + 1][1], blocks[i][2] + blocks[i + 1][2]]]
                i = max(i - 1, 0)
            else:
                i += 1
        out: list[float] = []
        for v, _, c in blocks:
            out += [v] * c
        return out

    if out_bands:
        ws = [b["n"] for b in out_bands]
        for key in ("rating", "floor"):
            smoothed = pav([b[key] for b in out_bands], ws)
            for b, v in zip(out_bands, smoothed):
                b[key] = round(float(v), 3 if key == "floor" else 2)
    ranked_keys = set(rec["key"])
    other = first_year[~first_year["key"].isin(ranked_keys) & (first_year["f"] >= 0.2)]
    unranked = {"rating": round(float(np.average(other["v_net"], weights=other["f"])), 2), "floor": round(float(other["f"].mean()), 3), "n": int(len(other))}
    print(f"unranked first-year players with real minutes: n={unranked['n']}, mean rating {unranked['rating']:+.2f}, mean floor share {unranked['floor']:.2f}")

    out = {"class_year": class_year, "bands": out_bands, "unranked": unranked, "max_rank": 200}
    CALIBRATION_JSON.write_text(json.dumps(out, indent=1))
    return out


def prior(rank: int | None, cal: dict | None = None) -> tuple[float, float]:
    """(rating, floor share f) for a freshman of this recruit rank (None / beyond the ranked list = unranked)."""
    cal = cal or json.loads(CALIBRATION_JSON.read_text())
    if rank is None or rank > cal.get("max_rank", 200):
        return float(cal["unranked"]["rating"]), float(cal["unranked"]["floor"])
    bands = cal["bands"]
    xs = [b["center"] for b in bands]
    lr = float(np.log(rank))
    rating = float(np.interp(lr, xs, [b["rating"] for b in bands]))
    floor = float(np.interp(lr, xs, [b["floor"] for b in bands]))
    # the last band's end is #200; between it and the unranked default, fade toward the unranked values
    if lr > xs[-1]:
        t = min(1.0, (lr - xs[-1]) / max(np.log(200) - xs[-1], 1e-6))
        rating = float((1 - t) * bands[-1]["rating"] + t * cal["unranked"]["rating"])
        floor = float((1 - t) * bands[-1]["floor"] + t * cal["unranked"]["floor"])
    return rating, floor


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
