"""
NBA history from ESPN's public APIs (the same ones behind espn.com): every game's schedule, box score (players, team totals, the
referee crew) and DraftKings/other books' open and close lines. Raw responses are cached under data/nba/raw so a run only fetches
what it does not have, politely (6 workers, retries with backoff).

    python -m nba_model.ingest schedule --first 2021 --last 2025
    python -m nba_model.ingest games    --first 2021 --last 2025
    python -m nba_model.ingest odds     --first 2021 --last 2025
    python -m nba_model.ingest all      --first 2021 --last 2025

Seasons are labelled by their START year (2021 = 2021-22). Preseason games are skipped.
"""
from __future__ import annotations

import argparse
import datetime as dt
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

from cbb_model.ingest import _get_json, _run_pool, _trim_event, _write_gz, read_gz  # same helpers the college basketball pipeline uses

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "nba"
RAW_SB = DATA_DIR / "raw" / "scoreboard"
RAW_GAMES = DATA_DIR / "raw" / "games"
RAW_ODDS = DATA_DIR / "raw" / "odds"
SCHEDULE_CSV = DATA_DIR / "schedule.csv"
TEAMS_CSV = DATA_DIR / "teams.csv"

SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba"
WORKERS = 6


def season_of(d: dt.date) -> int:
    return d.year if d.month >= 8 else d.year - 1


def season_dates(season: int) -> list[dt.date]:
    """Every day an NBA regular-season, play-in or playoff game could be played in the season starting in `season`."""
    start = dt.date(season, 10, 1)
    end = dt.date(season + 1, 6, 28)
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


# ------------------------------------------------------------------ schedule

def fetch_scoreboard_day(d: dt.date) -> bool:
    path = RAW_SB / f"{d:%Y%m%d}.json.gz"
    if path.exists():
        return False
    data = _get_json(f"{SITE}/scoreboard", {"dates": d.strftime("%Y%m%d"), "limit": 100})
    _write_gz(path, [_trim_event(e) for e in (data or {}).get("events", [])])
    return True


def build_schedule() -> pd.DataFrame:
    rows = []
    for path in sorted(RAW_SB.glob("*.json.gz")):
        for e in read_gz(path):
            home = next((t for t in e["teams"] if t["home_away"] == "home"), None)
            away = next((t for t in e["teams"] if t["home_away"] == "away"), None)
            if not home or not away or not e.get("date"):
                continue
            d = pd.Timestamp(e["date"])
            d = d.tz_convert("UTC") if d.tzinfo else d.tz_localize("UTC")
            rows.append(
                {
                    "event_id": int(e["id"]), "start_utc": d.isoformat(), "season": season_of((d - pd.Timedelta(hours=8)).date()),
                    "season_type": e.get("season_type"), "completed": e["completed"], "detail": e.get("detail"), "periods": e.get("periods"),
                    "neutral": e["neutral"], "notes": "; ".join(e.get("notes") or []),
                    "home_id": int(home["id"]) if home["id"] else None, "home": home["name"], "home_abbrev": home["abbrev"],
                    "home_score": int(home["score"]) if home.get("score") not in (None, "") else None,
                    "away_id": int(away["id"]) if away["id"] else None, "away": away["name"], "away_abbrev": away["abbrev"],
                    "away_score": int(away["score"]) if away.get("score") not in (None, "") else None,
                }
            )
    df = pd.DataFrame(rows).drop_duplicates("event_id").sort_values(["start_utc", "event_id"]).reset_index(drop=True)
    df.to_csv(SCHEDULE_CSV, index=False)
    teams = (
        pd.concat([df[["home_id", "home", "home_abbrev"]].set_axis(["id", "name", "abbrev"], axis=1), df[["away_id", "away", "away_abbrev"]].set_axis(["id", "name", "abbrev"], axis=1)])
        .dropna(subset=["id"]).drop_duplicates("id").sort_values("name")
    )
    teams.to_csv(TEAMS_CSV, index=False)
    return df


def ingest_schedule(first: int, last: int) -> None:
    today = dt.date.today()
    days = [d for s in range(last, first - 1, -1) for d in season_dates(s) if d <= today and not (RAW_SB / f"{d:%Y%m%d}.json.gz").exists()]
    print(f"schedule: {len(days)} days to fetch", flush=True)
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for f in as_completed([ex.submit(fetch_scoreboard_day, d) for d in days]):
            f.result()
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(days)} days - {time.time() - t0:.0f}s", flush=True)
    df = build_schedule()
    print(f"schedule: {len(df):,} games, {int(df['completed'].sum()):,} completed -> {SCHEDULE_CSV}", flush=True)


# ------------------------------------------------------------------ box scores

def _trim_summary(j: dict) -> dict:
    box = j.get("boxscore", {}) or {}
    players = []
    for t in box.get("players", []) or []:
        team_id = (t.get("team") or {}).get("id")
        for grp in t.get("statistics", []) or []:
            labels = grp.get("labels") or []
            for a in grp.get("athletes", []) or []:
                ath = a.get("athlete") or {}
                players.append(
                    {
                        "team_id": team_id, "id": ath.get("id"), "name": ath.get("displayName"), "pos": (ath.get("position") or {}).get("abbreviation"),
                        "starter": a.get("starter"), "dnp": a.get("didNotPlay"), "reason": a.get("reason"), "labels": labels, "stats": a.get("stats"),
                    }
                )
    team_stats = [
        {"team_id": (t.get("team") or {}).get("id"), "home_away": t.get("homeAway"), "stats": {s.get("name"): s.get("displayValue") for s in t.get("statistics", []) or []}}
        for t in box.get("teams", []) or []
    ]
    comp = ((j.get("header") or {}).get("competitions") or [{}])[0]
    gi = j.get("gameInfo") or {}
    return {
        "players": players,
        "team_stats": team_stats,
        "officials": [o.get("displayName") for o in gi.get("officials", []) or []],
        "periods": (comp.get("status") or {}).get("period"),
        "detail": ((comp.get("status") or {}).get("type") or {}).get("detail"),
        "attendance": gi.get("attendance"),
    }


def fetch_game(season: int, event_id: int) -> bool:
    path = RAW_GAMES / str(season) / f"{event_id}.json.gz"
    if path.exists():
        return False
    j = _get_json(f"{SITE}/summary", {"event": event_id})
    _write_gz(path, {"missing": True} if j is None else _trim_summary(j))
    return True


def _wanted(first: int, last: int) -> pd.DataFrame:
    sched = pd.read_csv(SCHEDULE_CSV)
    sched = sched[sched["completed"] & sched["season"].between(first, last) & (sched["season_type"] != 1)]
    return sched.sort_values("season", ascending=False)


def ingest_games(first: int, last: int) -> None:
    sched = _wanted(first, last)
    jobs = [(int(r.season), int(r.event_id)) for r in sched.itertuples() if not (RAW_GAMES / str(int(r.season)) / f"{int(r.event_id)}.json.gz").exists()]
    _run_pool("box scores", jobs, fetch_game)


# ------------------------------------------------------------------ odds

def fetch_odds(season: int, event_id: int) -> bool:
    path = RAW_ODDS / str(season) / f"{event_id}.json.gz"
    if path.exists():
        return False
    j = _get_json(f"{CORE}/events/{event_id}/competitions/{event_id}/odds")
    items = (j or {}).get("items", [])
    for it in items:  # drop the $ref links; they are most of the payload
        for k in [k for k in it if k.startswith("$") or k in ("link", "links")]:
            it.pop(k, None)
    _write_gz(path, {"items": items})
    return True


def ingest_odds(first: int, last: int) -> None:
    sched = _wanted(first, last)
    jobs = [(int(r.season), int(r.event_id)) for r in sched.itertuples() if not (RAW_ODDS / str(int(r.season)) / f"{int(r.event_id)}.json.gz").exists()]
    _run_pool("odds", jobs, fetch_odds)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["schedule", "games", "odds", "all"])
    ap.add_argument("--first", type=int, default=2021)
    ap.add_argument("--last", type=int, default=season_of(dt.date.today()))
    a = ap.parse_args()
    if a.what in ("schedule", "all"):
        ingest_schedule(a.first, a.last)
    if a.what in ("games", "all"):
        ingest_games(a.first, a.last)
    if a.what in ("odds", "all"):
        ingest_odds(a.first, a.last)


if __name__ == "__main__":
    main()
