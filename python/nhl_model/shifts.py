"""
Shift charts: who was on the ice, second by second - the raw material for player-level ratings.

The NHL's play-by-play lists events but not who was on the ice for them. The shift chart does: one row per player
per shift (period, start, end). Joined to the shots we already have (shots_xg.csv.gz: time, shooter, strength, xG),
every shot can be attributed to the five skaters (and goalie) on the ice for each side, which is what an
adjusted plus-minus model needs.

Downloads are resumable: one gzipped file per game under data/nhl/raw/shifts/<season>/, only missing games fetched.
Only the fields the ratings need are kept (~270 KB of JSON per game becomes ~15 KB).

    python -m nhl_model.shifts 2022 2026         # seasons first..last (start years)
"""
from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd

from .ingest import DATA_DIR, SCHEDULE_CSV, _completed, _get_json, _write_gz

RAW_SHIFTS = DATA_DIR / "raw" / "shifts"
SHIFTS_URL = "https://api.nhle.com/stats/rest/en/shiftcharts"
WORKERS = 4  # polite: the stats API is happy at this rate, and a few hundred games a minute is plenty

KEEP = ("playerId", "teamId", "teamAbbrev", "period", "startTime", "endTime", "duration", "typeCode", "detailCode")


def _trim(rows: list[dict]) -> list[dict]:
    return [{k: r.get(k) for k in KEEP} for r in rows]


def run_shifts(first: int, last: int) -> int:
    """Fetches any missing shift charts; returns how many new files were saved."""
    sched = _completed(pd.read_csv(SCHEDULE_CSV))
    sched = sched[(sched["season"] >= first) & (sched["season"] <= last)]
    todo = [(int(r.game_id), int(r.season)) for r in sched.itertuples() if not (RAW_SHIFTS / str(r.season) / f"{r.game_id}.json.gz").exists()]
    print(f"{len(sched)} completed games in range, {len(todo)} shift charts to fetch", flush=True)
    if not todo:
        return 0

    def fetch(item):
        gid, season = item
        d = _get_json(SHIFTS_URL, params={"cayenneExp": f"gameId={gid}"})
        if d is None or "data" not in d:
            return gid, False
        _write_gz(RAW_SHIFTS / str(season) / f"{gid}.json.gz", {"game_id": gid, "data": _trim(d["data"])})
        return gid, True

    done = failed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed([ex.submit(fetch, it) for it in todo]):
            try:
                _, ok = fut.result()
            except Exception as e:  # leave it for the next (resumable) run
                ok = False
                print("fetch error:", str(e)[:120], flush=True)
            done += 1
            failed += 0 if ok else 1
            if done % 250 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)} fetched ({failed} failed) - {time.time() - t0:.0f}s", flush=True)
    return done - failed


def main() -> None:
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2022
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    run_shifts(first, last)


if __name__ == "__main__":
    main()
