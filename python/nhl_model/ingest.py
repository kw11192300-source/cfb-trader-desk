"""
Pulls NHL history into local files - schedule + results, play-by-play, and
ESPN's historical odds - for the NHL model (see parse.py / xg.py /
baseline.py). Everything lands under python/data/nhl/ (gitignored): the raw
play-by-play alone is millions of rows, which has no business in git or in
Supabase (a Supabase egress quota outage already happened once from reading
a decade of CFB history every few hours) - only small model OUTPUTS ever go
to the database.

Sources, all free and keyless:
  - NHL's own API (api-web.nhle.com): schedule/results + full play-by-play
    (every shot with x/y, shot type, a strength-state code per event,
    penalties, goalie in net) back to 2011.
  - ESPN's core odds API: per-book open/close moneyline, puck line and total
    for COMPLETED games - two-sided closing lines from 2022-23 on, a single
    `current` snapshot per book for 2019-20 through 2021-22, nothing before.
    Joined to NHL games by home/away team + start time (no shared game id).

Resumable: every raw response is cached as .json.gz on first fetch, so a
rerun (or a crash) only fetches what's missing. Deliberately polite to
unofficial public endpoints - a handful of worker threads, retries with
backoff, no hammering.

Usage:
    python -m nhl_model.ingest schedule --first 2015 --last 2026
    python -m nhl_model.ingest pbp      --first 2015 --last 2026
    python -m nhl_model.ingest odds     --first 2019 --last 2026
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
import requests

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "nhl"
RAW_PBP = DATA_DIR / "raw" / "pbp"
RAW_ODDS = DATA_DIR / "raw" / "odds"
RAW_ESPN_SB = DATA_DIR / "raw" / "espn_scoreboard"
SCHEDULE_CSV = DATA_DIR / "schedule.csv"
ESPN_EVENTS_CSV = DATA_DIR / "espn_events.csv"
ODDS_MAP_CSV = DATA_DIR / "odds_map.csv"

NHL_WEB = "https://api-web.nhle.com/v1"
ESPN_SB = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard"
ESPN_CORE_ODDS = "https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/events/{eid}/competitions/{eid}/odds"
HEADERS = {"User-Agent": "Mozilla/5.0 (cfb-trader-desk nhl model)"}
WORKERS = 6

# ESPN abbreviations that differ from the NHL API's.
ESPN_TO_NHL_ABBREV = {"LA": "LAK", "NJ": "NJD", "SJ": "SJS", "TB": "TBL", "UTAH": "UTA"}


def _get_json(url: str, params: dict | None = None, tries: int = 5) -> dict | None:
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (2**attempt) + random.random())
    return None


def _write_gz(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(obj, f)
    tmp.replace(path)


def read_gz(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------- schedule

def list_season_games(season_start: int) -> list[dict]:
    """Every regular-season game NHL's weekly schedule endpoint lists for the
    season that starts in `season_start`, walked via nextStartDate."""
    games: dict[int, dict] = {}
    day = dt.date(season_start, 9, 1)
    end = dt.date(season_start + 1, 7, 31)
    while day is not None and day <= end:
        d = _get_json(f"{NHL_WEB}/schedule/{day.isoformat()}")
        if not d:
            break
        for wk in d.get("gameWeek", []):
            for g in wk.get("games", []):
                if g.get("gameType") != 2:
                    continue
                games[g["id"]] = {
                    "game_id": g["id"],
                    "season": season_start,
                    "start_utc": g["startTimeUTC"],
                    "home_abbrev": g["homeTeam"]["abbrev"],
                    "away_abbrev": g["awayTeam"]["abbrev"],
                    "home_team_id": g["homeTeam"]["id"],
                    "away_team_id": g["awayTeam"]["id"],
                    "game_state": g.get("gameState"),
                    "home_score": g["homeTeam"].get("score"),
                    "away_score": g["awayTeam"].get("score"),
                    "last_period": (g.get("gameOutcome") or {}).get("lastPeriodType"),
                    "neutral_site": bool(g.get("neutralSite")),
                    "venue": (g.get("venue") or {}).get("default"),
                }
        nxt = d.get("nextStartDate")
        day = dt.date.fromisoformat(nxt) if nxt else None
    return list(games.values())


def run_schedule(first: int, last: int) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {ex.submit(list_season_games, y): y for y in range(first, last + 1)}
        for f in as_completed(futs):
            games = f.result()
            print(f"season {futs[f]}: {len(games)} regular-season games listed")
            rows.extend(games)
    df = pd.DataFrame(rows)
    if SCHEDULE_CSV.exists():
        # refresh only the requested seasons - never drop the rest of the history
        old = pd.read_csv(SCHEDULE_CSV)
        df = pd.concat([old[~old["season"].between(first, last)], df], ignore_index=True)
    df = df.sort_values(["start_utc", "game_id"]).reset_index(drop=True)
    df.to_csv(SCHEDULE_CSV, index=False)
    print(f"wrote {len(df)} games -> {SCHEDULE_CSV}")


# ---------------------------------------------------------------------- pbp

def _completed(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["game_state"].isin(["FINAL", "OFF"])]


def run_pbp(first: int, last: int) -> None:
    sched = _completed(pd.read_csv(SCHEDULE_CSV))
    sched = sched[(sched["season"] >= first) & (sched["season"] <= last)]
    todo = [(int(r.game_id), int(r.season)) for r in sched.itertuples() if not (RAW_PBP / str(r.season) / f"{r.game_id}.json.gz").exists()]
    print(f"{len(sched)} completed games in range, {len(todo)} play-by-play files to fetch")

    def fetch(item):
        gid, season = item
        d = _get_json(f"{NHL_WEB}/gamecenter/{gid}/play-by-play")
        if d is None:
            return gid, False
        _write_gz(RAW_PBP / str(season) / f"{gid}.json.gz", d)
        return gid, True

    done = failed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed([ex.submit(fetch, it) for it in todo]):
            try:
                _, ok = fut.result()
            except Exception as e:  # leave it for the next (resumable) run
                ok = False
                print("fetch error:", str(e)[:120])
            done += 1
            failed += 0 if ok else 1
            if done % 500 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)} fetched ({failed} failed) - {time.time() - t0:.0f}s")


# --------------------------------------------------------------------- odds

def _et_date(start_utc: str) -> dt.date:
    t = dt.datetime.fromisoformat(start_utc.replace("Z", "+00:00"))
    return (t - dt.timedelta(hours=5)).date()  # close enough to ET for bucketing a day's games


def run_odds(first: int, last: int) -> None:
    sched = _completed(pd.read_csv(SCHEDULE_CSV))
    sched = sched[(sched["season"] >= first) & (sched["season"] <= last)].copy()
    sched["et_date"] = sched["start_utc"].map(_et_date)
    days = sorted({d for d in sched["et_date"]} | {d - dt.timedelta(days=1) for d in sched["et_date"]})

    def sb(day: dt.date):
        path = RAW_ESPN_SB / f"{day.strftime('%Y%m%d')}.json.gz"
        if path.exists():
            return read_gz(path)
        d = _get_json(ESPN_SB, {"dates": day.strftime("%Y%m%d")})
        _write_gz(path, d or {})
        return d or {}

    events = []
    print(f"{len(days)} ESPN scoreboard days to read")
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for d in ex.map(sb, days):
            for e in (d or {}).get("events", []):
                comp = e["competitions"][0]
                home = next(c for c in comp["competitors"] if c["homeAway"] == "home")["team"]["abbreviation"]
                away = next(c for c in comp["competitors"] if c["homeAway"] == "away")["team"]["abbreviation"]
                events.append(
                    {
                        "espn_id": e["id"],
                        "start_utc": e["date"],
                        "home_abbrev": ESPN_TO_NHL_ABBREV.get(home, home),
                        "away_abbrev": ESPN_TO_NHL_ABBREV.get(away, away),
                        "completed": bool(e["status"]["type"]["completed"]),
                    }
                )
    ev = pd.DataFrame(events).drop_duplicates("espn_id")
    ev.to_csv(ESPN_EVENTS_CSV, index=False)

    # join to NHL games: same home/away + nearest start time within 6h
    ev["t"] = pd.to_datetime(ev["start_utc"], utc=True)
    sched["t"] = pd.to_datetime(sched["start_utc"], utc=True)
    mapped = []
    by_pair = {k: g for k, g in ev.groupby(["home_abbrev", "away_abbrev"])}
    for r in sched.itertuples():
        g = by_pair.get((r.home_abbrev, r.away_abbrev))
        if g is None:
            continue
        diff = (g["t"] - r.t).abs()
        if diff.min() <= pd.Timedelta(hours=6):
            mapped.append({"game_id": r.game_id, "season": r.season, "espn_id": g.loc[diff.idxmin(), "espn_id"]})
    mp = pd.DataFrame(mapped)
    mp.to_csv(ODDS_MAP_CSV, index=False)
    print(f"matched {len(mp)}/{len(sched)} NHL games to ESPN events")

    todo = [(r.espn_id, r.season) for r in mp.itertuples() if not (RAW_ODDS / str(r.season) / f"{r.espn_id}.json.gz").exists()]
    print(f"{len(todo)} ESPN odds files to fetch")

    def fetch(item):
        eid, season = item
        d = _get_json(ESPN_CORE_ODDS.format(eid=eid))
        _write_gz(RAW_ODDS / str(season) / f"{eid}.json.gz", d or {})

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed([ex.submit(fetch, it) for it in todo]):
            try:
                fut.result()
            except Exception as e:
                print("fetch error:", str(e)[:120])
            done += 1
            if done % 500 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)} - {time.time() - t0:.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["schedule", "pbp", "odds"])
    ap.add_argument("--first", type=int, default=2015)
    ap.add_argument("--last", type=int, default=2026)
    a = ap.parse_args()
    {"schedule": run_schedule, "pbp": run_pbp, "odds": run_odds}[a.step](a.first, a.last)


if __name__ == "__main__":
    main()
