"""
One command to bring the NHL model fully up to date and publish it.

    python -m nhl_model.daily             # refresh everything, write to Supabase
    python -m nhl_model.daily --dry-run   # same, but print instead of writing

Steps (each reuses the module of the same name):
  1. schedule + results for the CURRENT season (history is left alone; on a machine with no
     history yet it pulls every season since 2015-16 - about 25 minutes the first time)
  2. play-by-play for any newly completed games (resumable - only fetches what's missing)
  3. parse -> xG -> team-game table -> simulation inputs (the xG model is refit
     cross-fitted by season each time, ~5 minutes - fine for a once-a-day job)
  4. publish: predictions for the next few days + xG for recently finished games
  5. team + goalie tables for the site's Teams / Goalies tabs (team_stats.py)
  6. skater ratings from shift charts (shifts.py -> player_ratings.py), refit when new games arrived

Runs on this machine. GitHub's scheduler only fires the repo's cron jobs a few
times a day right now, so this isn't wired into Actions; it belongs on the
always-on worker once that exists.
"""
from __future__ import annotations

import argparse
import time

from cfbd_ingest.sync_nhl_espn import _season_year

import pandas as pd

from . import ingest, parse, player_ratings, publish, shifts, sim_inputs, team_games, team_stats, xg

FIRST_SEASON = 2015  # 2015-16: the oldest season the model trains on


def derived_data_current() -> bool:
    """True when every finished game we have play-by-play for is already in the parsed tables - i.e. nothing new
    finished since the last full run, so parse -> xG -> team games -> simulation inputs would reproduce the same
    files. Lets a "refresh because a goalie got confirmed" run skip ~4 of its 5 minutes."""
    needed = [parse.GAMES_OUT, xg.SHOTS_XG_OUT, team_games.TEAM_GAMES_OUT, sim_inputs.SIM_TEAM_GAMES_OUT, sim_inputs.SIM_TABLES_OUT]
    if not all(p.exists() for p in needed):
        return False
    sched = pd.read_csv(ingest.SCHEDULE_CSV)
    done = sched[sched["game_state"].isin(["FINAL", "OFF"])]
    have_raw = {int(r.game_id) for r in done.itertuples() if (ingest.RAW_PBP / str(int(r.season)) / f"{int(r.game_id)}.json.gz").exists()}
    parsed = set(pd.read_csv(parse.GAMES_OUT, usecols=["game_id"])["game_id"])
    return have_raw <= parsed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-xg", action="store_true", help="reuse the existing xG file (only safe if no new games finished)")
    a = ap.parse_args()
    season = _season_year()
    # A blank machine (e.g. a fresh GitHub Actions runner with no cache) has no history yet:
    # pull every season once, then it's incremental - only the current season's schedule is
    # refreshed and only play-by-play files that don't exist yet get fetched.
    first = season if ingest.SCHEDULE_CSV.exists() else FIRST_SEASON
    t0 = time.time()
    for name, fn in (
        (f"schedule {first}-{season}", lambda: ingest.run_schedule(first, season)),
        (f"play-by-play {FIRST_SEASON}-{season}", lambda: ingest.run_pbp(FIRST_SEASON, season)),
    ):
        print(f"\n=== {name} ({time.time() - t0:.0f}s elapsed) ===")
        fn()

    # the heavy rebuild only matters when a game finished since the last one
    if a.skip_xg or derived_data_current():
        print(f"\n=== parse / xG / team games / simulation inputs: nothing new finished - reusing the last build ({time.time() - t0:.0f}s elapsed) ===")
    else:
        for name, fn in (("parse", parse.run), ("xG", xg.run), ("team games", team_games.run), ("simulation inputs", sim_inputs.run)):
            print(f"\n=== {name} ({time.time() - t0:.0f}s elapsed) ===")
            fn()

    print(f"\n=== publish ({time.time() - t0:.0f}s elapsed) ===")
    publish.main(["--dry-run"] if a.dry_run else [])
    print(f"\n=== team + goalie tables ({time.time() - t0:.0f}s elapsed) ===")
    team_stats.main(["--dry-run"] if a.dry_run else [])

    # skater ratings: pull shift charts for newly finished games, and refit only when something new arrived (or never fit)
    print(f"\n=== skater ratings ({time.time() - t0:.0f}s elapsed) ===")
    try:
        new_shifts = shifts.run_shifts(player_ratings.FIRST_SEASON, season)
        if new_shifts > 0 or not player_ratings.RATINGS_JSON.exists():
            player_ratings.run(first=player_ratings.FIRST_SEASON, last=season, publish=not a.dry_run)
        else:
            print("no new shift charts - keeping the current skater ratings")
    except Exception as e:  # noqa: BLE001 - ratings are an add-on; never fail the refresh over them
        print(f"(skater ratings skipped: {str(e)[:150]})")
    print(f"\ndone in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
