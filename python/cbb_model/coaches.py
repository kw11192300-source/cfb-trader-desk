"""
Does the head coach carry information the roster does not? Pulls each D1 team's head coach for every season (ESPN's roster feed
names the coach of the season asked for), then tests whether a coach's results BEYOND what the roster-based preseason model
predicted persist from one season to the next:

    residual(team, season) = actual end-of-season rating - preseason projection
    does mean residual of the same coach in OTHER seasons predict this season's residual?  (leave-one-season-out, shrunk)

If yes, a coach effect is a legitimate feature; the size of the coefficient says how much weight it deserves. Also looks at the
first-year-with-a-new-coach effect, which is the other common claim.

Usage:
    python -m cbb_model.coaches fetch
    python -m cbb_model.coaches evaluate
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

from .bpm import PLAYER_SEASONS_OUT, TARGETS_OUT, per40
from .ingest import DATA_DIR
from .preseason import FEATURES, season_table, value_weights
from .bpm import ridge

H = {"User-Agent": "Mozilla/5.0"}
SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"
COACHES_CSV = DATA_DIR / "coaches.csv"


def fetch(first: int = 2018, last: int = 2025) -> None:
    conf = pd.read_csv(DATA_DIR / "conferences.csv")
    jobs = [(int(t), int(s)) for s in range(first, last + 1) for t in conf[conf["season"] == s]["team_id"].unique()]

    def one(job):
        t, s = job
        try:
            j = requests.get(f"{SITE}/teams/{t}/roster", params={"season": s + 1}, headers=H, timeout=30).json()
            c = (j.get("coach") or [{}])[0]
            return {"season": s, "team_id": t, "coach_id": c.get("id"), "coach": f"{c.get('firstName', '')} {c.get('lastName', '')}".strip() or None}
        except Exception:
            return {"season": s, "team_id": t, "coach_id": None, "coach": None}

    with ThreadPoolExecutor(8) as ex:
        rows = list(ex.map(one, jobs))
    df = pd.DataFrame(rows)
    df.to_csv(COACHES_CSV, index=False)
    print(f"{len(df):,} team-seasons, {df['coach_id'].notna().mean():.1%} with a coach", flush=True)


def evaluate() -> None:
    co = pd.read_csv(COACHES_CSV)
    ps40 = per40(pd.read_csv(PLAYER_SEASONS_OUT))
    tgt = pd.read_csv(TARGETS_OUT)
    tables = []
    for S in range(2020, 2026):
        t = season_table(ps40, tgt, S, value_weights(ps40, tgt, S)).merge(tgt[["season", "team_id", "off", "de", "games"]], on=["season", "team_id"])
        tables.append(t)
    d = pd.concat(tables)
    d = d[(d["games"] >= 15) & d["prior_off"].notna()].copy()
    # residuals of the roster model, itself predicted out-of-season
    X = d[FEATURES].to_numpy()
    for key in ("off", "de"):
        y = d[key].to_numpy()
        pred = np.zeros(len(d))
        for S in sorted(d["season"].unique()):
            m = (d["season"] == S).to_numpy()
            pred[m] = np.c_[np.ones(m.sum()), X[m]] @ ridge(X[~m], y[~m], 3.0)
        d[f"res_{key}"] = y - pred
    d["res_net"] = d["res_off"] - d["res_de"]
    d = d.merge(co[["season", "team_id", "coach_id"]], on=["season", "team_id"], how="left")
    d = d[d["coach_id"].notna()]
    print(f"{len(d):,} team-seasons with a coach and a residual; {d['coach_id'].nunique():,} coaches", flush=True)

    # does a coach's residual in OTHER seasons predict this one?
    prev, now, n_other = [], [], []
    for r in d.itertuples():
        others = d[(d["coach_id"] == r.coach_id) & (d["season"] != r.season)]
        if len(others):
            prev.append(others["res_net"].mean())
            now.append(r.res_net)
            n_other.append(len(others))
    prev, now, n_other = np.array(prev), np.array(now), np.array(n_other)
    slope = float(np.dot(prev - prev.mean(), now - now.mean()) / np.dot(prev - prev.mean(), prev - prev.mean()))
    corr = float(np.corrcoef(prev, now)[0, 1])
    print(f"coach persistence: n={len(prev):,} team-seasons with the same coach elsewhere in the sample")
    print(f"  corr(coach's mean residual in other seasons, this season's residual) = {corr:+.3f}, slope {slope:+.2f}")
    for lo, hi in ((1, 1), (2, 3), (4, 9)):
        m = (n_other >= lo) & (n_other <= hi)
        if m.sum() > 30:
            print(f"    with {lo}-{hi} other seasons: n={int(m.sum())}, corr {np.corrcoef(prev[m], now[m])[0, 1]:+.3f}, slope {np.dot(prev[m] - prev[m].mean(), now[m] - now[m].mean()) / np.dot(prev[m] - prev[m].mean(), prev[m] - prev[m].mean()):+.2f}")

    # first season under a new coach
    d = d.sort_values(["team_id", "season"])
    d["new_coach"] = (d.groupby("team_id")["coach_id"].shift(1) != d["coach_id"]) & d.groupby("team_id")["coach_id"].shift(1).notna()
    nc = d[d["new_coach"]]
    print(f"new coach first season: n={len(nc):,}, mean residual net {nc['res_net'].mean():+.2f} (se {nc['res_net'].std() / np.sqrt(len(nc)):.2f}) vs all {d['res_net'].mean():+.2f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["fetch", "evaluate"])
    a = ap.parse_args()
    fetch() if a.what == "fetch" else evaluate()


if __name__ == "__main__":
    main()
