"""
One command to bring the NHL model fully up to date and publish it.

    python -m nhl_model.daily             # refresh everything, write to Supabase
    python -m nhl_model.daily --dry-run   # same, but print instead of writing

Steps (each reuses the module of the same name):
  1. schedule + results for the CURRENT season (history is left alone)
  2. play-by-play for any newly completed games (resumable - only fetches what's missing)
  3. parse -> xG -> team-game table -> simulation inputs (the xG model is refit
     cross-fitted by season each time, ~5 minutes - fine for a once-a-day job)
  4. publish: predictions for the next few days + xG for recently finished games

Runs on this machine. GitHub's scheduler only fires the repo's cron jobs a few
times a day right now, so this isn't wired into Actions; it belongs on the
always-on worker once that exists.
"""
from __future__ import annotations

import argparse
import time

from cfbd_ingest.sync_nhl_espn import _season_year

from . import ingest, parse, publish, sim_inputs, team_games, xg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-xg", action="store_true", help="reuse the existing xG file (only safe if no new games finished)")
    a = ap.parse_args()
    season = _season_year()
    steps = [
        (f"schedule {season}", lambda: ingest.run_schedule(season, season)),
        (f"play-by-play {season}", lambda: ingest.run_pbp(season, season)),
        ("parse", parse.run),
        ("xG", (lambda: print("  skipped")) if a.skip_xg else xg.run),
        ("team games", team_games.run),
        ("simulation inputs", sim_inputs.run),
        ("publish", lambda: publish.main(["--dry-run"] if a.dry_run else [])),
    ]
    t0 = time.time()
    for name, fn in steps:
        print(f"\n=== {name} ({time.time() - t0:.0f}s elapsed) ===")
        fn()
    print(f"\ndone in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
