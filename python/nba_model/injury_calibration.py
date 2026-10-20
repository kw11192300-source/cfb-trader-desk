"""
How often does a player listed Out / Doubtful / Questionable / Probable on the injury report actually play?

Past official reports exist from about January 2026. For each game day we fetch the reports at several Eastern times, match every
listed player to his game and the box score (did he play?), and tabulate P(play) by status, by how long before tip the report was
published, and by the kind of reason. The result is the lookup the availability model uses.

    python -m nba_model.injury_calibration fetch      # download + parse reports (cached), ~10 minutes
    python -m nba_model.injury_calibration table      # outcomes -> probabilities, writes data/nba/injury_probs.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

from .ingest import DATA_DIR
from .injuries import ET, HEADERS, parse_pdf, report_url
from .parse import GAMES_OUT, PLAYER_GAMES_OUT

RAW = DATA_DIR / "raw" / "injury"
PARSED = DATA_DIR / "injury_reports.csv.gz"
PROBS = DATA_DIR / "injury_probs.json"
FIRST, LAST = dt.date(2026, 1, 5), dt.date(2026, 6, 20)
HOURS = [(10, 30), (12, 30), (14, 30), (16, 30), (17, 30), (18, 30), (19, 30), (21, 0)]


def _fetch(t: dt.datetime) -> tuple[dt.datetime, bytes | None]:
    path = RAW / f"{t:%Y%m%d_%H%M}.pdf"
    if path.exists():
        return t, path.read_bytes()
    try:
        r = requests.get(report_url(t), headers=HEADERS, timeout=30)
    except Exception:
        return t, None
    if r.status_code != 200 or r.content[:4] != b"%PDF":
        return t, None
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    return t, r.content


def fetch() -> None:
    gm = pd.read_csv(GAMES_OUT)
    gm["et_date"] = pd.to_datetime(gm["start_utc"], utc=True).dt.tz_convert(ET).dt.date
    days = sorted(d for d in set(gm["et_date"]) if FIRST <= d <= LAST)
    times = [dt.datetime(d.year, d.month, d.day, h, m, tzinfo=ET) for d in days for h, m in HOURS]
    print(f"{len(days)} game days, {len(times)} report times to fetch", flush=True)
    got = 0
    rows = []
    with ThreadPoolExecutor(6) as ex:
        results = list(ex.map(_fetch, times))
    for t, content in results:
        if content is None:
            continue
        got += 1
        try:
            df = parse_pdf(content, t)
        except Exception:
            continue
        if len(df):
            rows.append(df)
    out = pd.concat(rows, ignore_index=True)
    out.to_csv(PARSED, index=False)
    print(f"{got} reports found; {len(out):,} parsed rows -> {PARSED}", flush=True)


def _key(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def table() -> None:
    rep = pd.read_csv(PARSED)
    rep = rep[rep["player"].notna() & rep["status"].isin(["Out", "Doubtful", "Questionable", "Probable", "Available"])].copy()
    rep["report_time"] = pd.to_datetime(rep["report_time"], utc=True)
    rep["game_date"] = pd.to_datetime(rep["game_date"], format="%m/%d/%Y").dt.date
    gm = pd.read_csv(GAMES_OUT)
    gm["start_utc"] = pd.to_datetime(gm["start_utc"], utc=True)
    gm["et_date"] = gm["start_utc"].dt.tz_convert(ET).dt.date
    teams = pd.concat([gm[["event_id", "et_date", "start_utc", "home", "home_id"]].rename(columns={"home": "team", "home_id": "team_id"}), gm[["event_id", "et_date", "start_utc", "away", "away_id"]].rename(columns={"away": "team", "away_id": "team_id"})])
    rep = rep.merge(teams, left_on=["game_date", "team"], right_on=["et_date", "team"], how="inner")
    pg = pd.read_csv(PLAYER_GAMES_OUT, usecols=["event_id", "team_id", "player_id", "name", "min"])
    pg["k"] = pg["name"].map(_key)
    rep["k"] = rep["player"].map(_key)
    played = pg.groupby(["event_id", "team_id", "k"])["min"].max().reset_index().rename(columns={"min": "mins"})
    m = rep.merge(played, on=["event_id", "team_id", "k"], how="left")
    m["listed_in_box"] = m["mins"].notna()
    m["played"] = (m["mins"].fillna(0) > 0).astype(int)
    m["hours"] = (m["start_utc"] - m["report_time"]).dt.total_seconds() / 3600.0
    m = m[(m["hours"] > 0) & (m["hours"] < 30)]
    m["bucket"] = pd.cut(m["hours"], [0, 1.5, 3, 6, 12, 30], labels=["<1.5h", "1.5-3h", "3-6h", "6-12h", "12h+"])
    m["cat"] = np.where(m["reason_cat"].fillna("").str.contains("Injury"), "injury/illness", np.where(m["reason_cat"].fillna("").str.contains("G League"), "g league", "other (personal, rest, ...)"))
    print(f"{len(m):,} listed-player observations matched to games")
    print(m.groupby("status").agg(n=("played", "size"), p_play=("played", "mean")).round(3).to_string())
    print("\nby status x hours before tip:")
    print(m.pivot_table(index="status", columns="bucket", values="played", aggfunc=["mean", "size"], observed=False).round(2).to_string())
    print("\nby status x reason (injury vs g league vs other):")
    print(m.pivot_table(index="status", columns="cat", values="played", aggfunc=["mean", "size"]).round(2).to_string())
    # the lookup: P(play) by status and bucket (fall back to the status average when a cell is thin)
    out = {"overall": {s: float(g["played"].mean()) for s, g in m.groupby("status")}, "by_bucket": {}, "by_cat": {}, "n": int(len(m))}
    for (s, b), g in m.groupby(["status", "bucket"], observed=True):
        if len(g) >= 30:
            out["by_bucket"][f"{s}|{b}"] = float(g["played"].mean())
    for (s, c), g in m.groupby(["status", "cat"]):
        if len(g) >= 30:
            out["by_cat"][f"{s}|{c}"] = float(g["played"].mean())
    PROBS.write_text(json.dumps(out, indent=1))
    print(f"\n-> {PROBS}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["fetch", "table"])
    a = ap.parse_args()
    fetch() if a.what == "fetch" else table()


if __name__ == "__main__":
    main()
