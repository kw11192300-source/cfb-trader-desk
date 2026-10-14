"""
Pulls Division I men's college basketball history into local files for the CBB model: schedule + results, every game's box
score and play-by-play (with substitutions, so lineups can be rebuilt), ESPN's per-book odds history, and current rosters
(with head coaches). Everything lands under python/data/cbb/ (gitignored) - raw play-by-play is far too big for git or
Supabase; only small model OUTPUTS ever go to the database (the Sept 2026 egress lesson).

Source: ESPN's public, keyless APIs (the same family as the NHL ingest).
  scoreboard   site.api.espn.com/.../mens-college-basketball/scoreboard?dates=YYYYMMDD&groups=50&limit=400
  summary      .../summary?event=ID   (boxscore, plays; trimmed before caching - the raw payload is mostly news and video)
  core odds    sports.core.api.espn.com/.../events/ID/competitions/ID/odds   (open/close per book where ESPN kept them)
  roster       .../teams/ID/roster   (height, weight, class, head coach)

Season convention: START year, like the rest of this repo (the 2025-26 season is 2025). ESPN labels a season by the year it
ENDS, so file paths use our start year and the schedule carries both.

Resumable: every raw response is cached as .json.gz on first fetch, so a rerun (or a crash) only fetches what is missing.

Usage:
    python -m cbb_model.ingest schedule --first 2018 --last 2025
    python -m cbb_model.ingest games    --first 2018 --last 2025     # box scores + play-by-play (the big one)
    python -m cbb_model.ingest odds     --first 2022 --last 2025
    python -m cbb_model.ingest rosters
    python -m cbb_model.ingest all      --first 2018 --last 2025     # newest seasons first within each step
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

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "cbb"
RAW_SB = DATA_DIR / "raw" / "scoreboard"
RAW_GAMES = DATA_DIR / "raw" / "games"
RAW_ODDS = DATA_DIR / "raw" / "odds"
RAW_ROSTERS = DATA_DIR / "raw" / "rosters"
SCHEDULE_CSV = DATA_DIR / "schedule.csv"
TEAMS_CSV = DATA_DIR / "teams.csv"

SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball"
HEADERS = {"User-Agent": "Mozilla/5.0 (cfb-trader-desk cbb model)"}
WORKERS = 6
GROUP_D1 = 50


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
        json.dump(obj, f, separators=(",", ":"))
    tmp.replace(path)


def read_gz(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def season_dates(season: int) -> list[dt.date]:
    """Every day a regular-season or postseason game could be played in the season starting in `season`."""
    start = dt.date(season, 11, 1)
    end = dt.date(season + 1, 4, 12)
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def season_of(d: dt.date) -> int:
    return d.year if d.month >= 8 else d.year - 1


# ------------------------------------------------------------------ schedule

def _trim_event(e: dict) -> dict:
    comp = (e.get("competitions") or [{}])[0]
    status = e.get("status", {}).get("type", {})
    out = {
        "id": e["id"],
        "date": e.get("date"),
        "espn_season": e.get("season", {}).get("year"),
        "season_type": e.get("season", {}).get("type"),
        "state": status.get("state"),
        "completed": bool(status.get("completed")),
        "detail": status.get("detail"),
        "periods": e.get("status", {}).get("period"),
        "neutral": bool(comp.get("neutralSite")),
        "conf_game": bool(comp.get("conferenceCompetition")),
        "venue": (comp.get("venue") or {}).get("fullName"),
        "notes": [n.get("headline") for n in comp.get("notes", []) if n.get("headline")],
        "teams": [],
    }
    for c in comp.get("competitors", []):
        t = c.get("team", {})
        out["teams"].append(
            {
                "home_away": c.get("homeAway"),
                "id": t.get("id"),
                "name": t.get("displayName"),
                "abbrev": t.get("abbreviation"),
                "score": c.get("score"),
                "winner": c.get("winner"),
                "rank": (c.get("curatedRank") or {}).get("current"),
            }
        )
    return out


def fetch_scoreboard_day(d: dt.date) -> bool:
    """Caches one day's D1 events. Returns True if it fetched (False when already cached)."""
    path = RAW_SB / f"{d:%Y%m%d}.json.gz"
    if path.exists():
        return False
    data = _get_json(f"{SITE}/scoreboard", {"dates": d.strftime("%Y%m%d"), "groups": GROUP_D1, "limit": 400})
    events = [_trim_event(e) for e in (data or {}).get("events", [])]
    _write_gz(path, events)
    return True


def build_schedule() -> pd.DataFrame:
    rows = []
    for path in sorted(RAW_SB.glob("*.json.gz")):
        for e in read_gz(path):
            home = next((t for t in e["teams"] if t["home_away"] == "home"), None)
            away = next((t for t in e["teams"] if t["home_away"] == "away"), None)
            if not home or not away or not e.get("date"):
                continue
            d = pd.Timestamp(e["date"]).tz_convert("UTC") if pd.Timestamp(e["date"]).tzinfo else pd.Timestamp(e["date"], tz="UTC")
            rows.append(
                {
                    "event_id": int(e["id"]),
                    "start_utc": d.isoformat(),
                    "season": season_of((d - pd.Timedelta(hours=8)).date()),
                    "espn_season": e.get("espn_season"),
                    "season_type": e.get("season_type"),
                    "completed": e["completed"],
                    "detail": e.get("detail"),
                    "periods": e.get("periods"),
                    "neutral": e["neutral"],
                    "conf_game": e["conf_game"],
                    "home_id": int(home["id"]) if home["id"] else None,
                    "home": home["name"],
                    "home_abbrev": home["abbrev"],
                    "home_score": int(home["score"]) if home.get("score") not in (None, "") else None,
                    "away_id": int(away["id"]) if away["id"] else None,
                    "away": away["name"],
                    "away_abbrev": away["abbrev"],
                    "away_score": int(away["score"]) if away.get("score") not in (None, "") else None,
                    "notes": "; ".join(e.get("notes") or []),
                }
            )
    df = pd.DataFrame(rows).drop_duplicates("event_id").sort_values(["start_utc", "event_id"]).reset_index(drop=True)
    df.to_csv(SCHEDULE_CSV, index=False)
    teams = (
        pd.concat(
            [
                df[["home_id", "home", "home_abbrev"]].set_axis(["id", "name", "abbrev"], axis=1),
                df[["away_id", "away", "away_abbrev"]].set_axis(["id", "name", "abbrev"], axis=1),
            ]
        )
        .dropna(subset=["id"])
        .drop_duplicates("id")
        .sort_values("name")
    )
    teams.to_csv(TEAMS_CSV, index=False)
    return df


def ingest_schedule(first: int, last: int) -> None:
    days = [d for s in range(last, first - 1, -1) for d in season_dates(s) if not (RAW_SB / f"{d:%Y%m%d}.json.gz").exists()]
    # the current season's future days aren't worth caching as empty - they'd never be refetched
    today = dt.date.today()
    days = [d for d in days if d <= today]
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
    print(f"schedule: {len(df):,} games, {df['completed'].sum():,} completed -> {SCHEDULE_CSV}", flush=True)


# ------------------------------------------------------------------ box scores + play-by-play

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
                        "team_id": team_id,
                        "id": ath.get("id"),
                        "name": ath.get("displayName"),
                        "pos": (ath.get("position") or {}).get("abbreviation"),
                        "starter": a.get("starter"),
                        "dnp": a.get("didNotPlay"),
                        "labels": labels,
                        "stats": a.get("stats"),
                    }
                )
    team_stats = [
        {"team_id": (t.get("team") or {}).get("id"), "home_away": t.get("homeAway"), "stats": {s.get("name"): s.get("displayValue") for s in t.get("statistics", []) or []}}
        for t in box.get("teams", []) or []
    ]
    plays = []
    for p in j.get("plays", []) or []:
        typ = (p.get("type") or {}).get("text")
        plays.append(
            {
                "t": typ,
                "txt": p.get("text") if typ == "Substitution" else None,
                "per": (p.get("period") or {}).get("number"),
                "clk": (p.get("clock") or {}).get("displayValue"),
                "as": p.get("awayScore"),
                "hs": p.get("homeScore"),
                "sc": 1 if p.get("scoringPlay") else 0,
                "sv": p.get("scoreValue"),
                "tm": (p.get("team") or {}).get("id"),
                "who": [x.get("athlete", {}).get("id") for x in p.get("participants", []) or []],
            }
        )
    comp = ((j.get("header") or {}).get("competitions") or [{}])[0]
    return {
        "players": players,
        "team_stats": team_stats,
        "plays": plays,
        "periods": (comp.get("status") or {}).get("period"),
        "detail": ((comp.get("status") or {}).get("type") or {}).get("detail"),
        "attendance": (j.get("gameInfo") or {}).get("attendance"),
    }


def fetch_game(season: int, event_id: int) -> bool:
    path = RAW_GAMES / str(season) / f"{event_id}.json.gz"
    if path.exists():
        return False
    j = _get_json(f"{SITE}/summary", {"event": event_id})
    if j is None:
        _write_gz(path, {"missing": True})
        return True
    _write_gz(path, _trim_summary(j))
    return True


def _run_pool(label: str, jobs: list[tuple], fn) -> None:
    print(f"{label}: {len(jobs):,} to fetch", flush=True)
    if not jobs:
        return
    t0 = time.time()
    done = fail = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = [ex.submit(fn, *j) for j in jobs]
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:  # noqa: BLE001 - one bad game must not stop the run; it is retried next time
                fail += 1
                if fail <= 5:
                    print(f"  (skipped one: {str(e)[:100]})", flush=True)
            done += 1
            if done % 500 == 0:
                rate = done / max(time.time() - t0, 1)
                print(f"  {done:,}/{len(jobs):,} - {rate:.1f}/s - eta {(len(jobs) - done) / max(rate, 0.1) / 60:.0f} min", flush=True)
    print(f"{label}: done in {(time.time() - t0) / 60:.1f} min, {fail} failed", flush=True)


def ingest_games(first: int, last: int) -> None:
    sched = pd.read_csv(SCHEDULE_CSV)
    sched = sched[sched["completed"] & sched["season"].between(first, last)].sort_values("season", ascending=False)
    jobs = [(int(r.season), int(r.event_id)) for r in sched.itertuples() if not (RAW_GAMES / str(int(r.season)) / f"{int(r.event_id)}.json.gz").exists()]
    _run_pool("box scores + play-by-play", jobs, fetch_game)


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
    sched = pd.read_csv(SCHEDULE_CSV)
    sched = sched[sched["completed"] & sched["season"].between(first, last)].sort_values("season", ascending=False)
    jobs = [(int(r.season), int(r.event_id)) for r in sched.itertuples() if not (RAW_ODDS / str(int(r.season)) / f"{int(r.event_id)}.json.gz").exists()]
    _run_pool("odds", jobs, fetch_odds)


# ------------------------------------------------------------------ rosters (current)

def ingest_rosters() -> None:
    teams = pd.read_csv(TEAMS_CSV) if TEAMS_CSV.exists() else None
    if teams is None:
        data = _get_json(f"{SITE}/teams", {"limit": 500})
        lst = data["sports"][0]["leagues"][0]["teams"]
        teams = pd.DataFrame([{"id": t["team"]["id"], "name": t["team"]["displayName"]} for t in lst])
    season = season_of(dt.date.today())
    jobs = [(int(r.id), season) for r in teams.itertuples()]

    def one(team_id: int, s: int) -> None:
        j = _get_json(f"{SITE}/teams/{team_id}/roster")
        if j is None:
            return
        slim = {
            "team": {"id": team_id, "name": (j.get("team") or {}).get("displayName")},
            "coach": j.get("coach"),
            "athletes": [
                {
                    "id": a.get("id"),
                    "name": a.get("fullName"),
                    "jersey": a.get("jersey"),
                    "height": a.get("height"),
                    "weight": a.get("weight"),
                    "class": (a.get("experience") or {}).get("abbreviation"),
                    "years": (a.get("experience") or {}).get("years"),
                    "pos": (a.get("position") or {}).get("abbreviation"),
                    "birthplace": a.get("birthPlace"),
                }
                for a in j.get("athletes", [])
            ],
            "fetched": dt.date.today().isoformat(),
        }
        _write_gz(RAW_ROSTERS / str(s) / f"{team_id}.json.gz", slim)

    _run_pool("rosters", jobs, one)


# ------------------------------------------------------------------ conferences

CONFERENCES_CSV = DATA_DIR / "conferences.csv"


def ingest_conferences(first: int, last: int) -> None:
    """Which conference each team was in, season by season (realignment moves teams), from ESPN's standings feed. The feed
    labels a season by the year it ends, so the season starting in `s` is asked for as s + 1."""
    rows = []
    for s in range(first, last + 1):
        j = _get_json("https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/standings", {"level": 3, "season": s + 1})
        for conf in (j or {}).get("children", []):
            for e in conf.get("standings", {}).get("entries", []):
                t = e.get("team", {})
                rows.append({"season": s, "conference": conf.get("name"), "conf_abbrev": conf.get("abbreviation"), "team_id": int(t["id"]), "team": t.get("displayName")})
    df = pd.DataFrame(rows).drop_duplicates(["season", "team_id"])
    df.to_csv(CONFERENCES_CSV, index=False)
    print(f"conferences: {len(df):,} team-seasons, {df.groupby('season')['team_id'].nunique().to_dict()}", flush=True)


# ------------------------------------------------------------------ cli

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["schedule", "games", "odds", "rosters", "conferences", "all"])
    ap.add_argument("--first", type=int, default=2018)
    ap.add_argument("--last", type=int, default=season_of(dt.date.today()))
    a = ap.parse_args()
    if a.what in ("schedule", "all"):
        ingest_schedule(a.first, a.last)
    if a.what in ("rosters", "all"):
        ingest_rosters()
    if a.what in ("conferences", "all"):
        ingest_conferences(a.first, a.last)
    if a.what in ("odds", "all"):
        ingest_odds(max(a.first, 2022), a.last)
    if a.what in ("games", "all"):
        ingest_games(a.first, a.last)


if __name__ == "__main__":
    main()
