"""
The in-season NBA ratings job: pulls the games that finished this season (box score + play-by-play), rebuilds this season's stints,
refits every player's lineup rating on top of the 2021-25 history, and republishes the Players page.

The history (2021-25 stints, box tables, absence study) is small and committed under python/models/nba_history, so a GitHub Actions run
starts from it and only downloads the current season's games (cached between runs). Locally the same command works on top of the
full raw data.

    python -m nba_model.inseason                 # ingest, refit, publish
    python -m nba_model.inseason --no-publish    # same, write data/nba/player_ratings.csv only
    python -m nba_model.inseason --export-history   # refresh models/nba_history from the current data/nba (after a new season ends)
"""
from __future__ import annotations

import argparse
import datetime as dt
import shutil
from pathlib import Path

import pandas as pd

from cbb_model.ingest import read_gz
from . import parse, players_table, rapm, stints
from .ingest import DATA_DIR, RAW_GAMES, RAW_PBP, RAW_SB, ingest_games, ingest_pbp, ingest_schedule, season_of

HIST = Path(__file__).resolve().parents[1] / "models" / "nba_history"
LAM, HALF_LIFE = 5000.0, 4.0  # the posterior ridge strength and the season half-life the published ratings were validated with
TABLES = [("team_games.csv.gz", "team_games"), ("player_games.csv.gz", "player_games"), ("games.csv", "games")]


def refresh_recent_cache(season: int, days: int = 3) -> None:
    """Scoreboard days and box scores are cached forever once fetched - which would freeze a game fetched before it finished."""
    for k in range(days + 1):
        d = dt.date.today() - dt.timedelta(days=k)
        p = RAW_SB / f"{d:%Y%m%d}.json.gz"
        if p.exists():
            p.unlink()
    for root in (RAW_GAMES, RAW_PBP):
        for p in (root / str(season)).glob("*.json.gz"):
            if read_gz(p).get("missing"):
                p.unlink()


def restore_history(season: int) -> None:
    (DATA_DIR / "stints").mkdir(parents=True, exist_ok=True)
    for src in HIST.glob("stints_*.csv.gz"):
        if int(src.name[7:11]) < season:
            shutil.copy(src, DATA_DIR / "stints" / src.name)
    for name in ("player_impact.csv",):
        if (HIST / name).exists() and not (DATA_DIR / name).exists():
            shutil.copy(HIST / name, DATA_DIR / name)


def build_tables(season: int) -> int:
    """History (< season) from models/nba_history + this season rebuilt from the raw files -> data/nba/*."""
    tg, pg, gm = parse.build_games()
    new = {"team_games": tg, "player_games": pg, "games": gm}
    n_games = 0
    for fname, key in TABLES:
        df = new[key]
        df = df[df["season"] == season] if len(df) else df
        old = pd.read_csv(HIST / fname) if (HIST / fname).exists() else pd.DataFrame()
        if len(old) and "season" in old:
            old = old[old["season"] < season]
        out = pd.concat([old, df], ignore_index=True) if len(old) else df
        out.to_csv(DATA_DIR / fname, index=False)
        if key == "games":
            n_games = len(df)
    return n_games


def export_history(through: int) -> None:
    """Snapshot the finished seasons into models/nba_history (run once when a season ends)."""
    HIST.mkdir(parents=True, exist_ok=True)
    for fname, _ in TABLES:
        df = pd.read_csv(DATA_DIR / fname)
        df[df["season"] <= through].to_csv(HIST / fname, index=False)
    for p in (DATA_DIR / "stints").glob("stints_*.csv.gz"):
        if int(p.name[7:11]) <= through:
            shutil.copy(p, HIST / p.name)
    shutil.copy(DATA_DIR / "player_impact.csv", HIST / "player_impact.csv")
    print(f"history through {through} -> {HIST}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--export-history", type=int, default=0, metavar="THROUGH_SEASON")
    ap.add_argument("--season", type=int, default=0, help="replay a past season as if it were the current one (testing)")
    a = ap.parse_args()
    if a.export_history:
        export_history(a.export_history)
        return
    season = a.season or season_of(dt.date.today())
    restore_history(season)
    refresh_recent_cache(season)
    ingest_schedule(season, season)
    ingest_games(season, season)
    ingest_pbp(season, season)
    n = build_tables(season)
    print(f"{season} season so far: {n} finished games", flush=True)
    sp = stints.STINTS_DIR / f"stints_{season}.csv.gz"
    if sp.exists():
        sp.unlink()
    if n:
        df, q, _ = stints.build_season(season)
        if len(df):
            df.to_csv(sp, index=False)
            print(f"{season}: {len(q)} games reconstructed, {len(df):,} stints, valid-seconds mean {sum(q) / len(q):.3f}", flush=True)
    ratings = rapm.fit_all(LAM, HALF_LIFE)
    ratings.to_csv(rapm.OUT, index=False)
    print(f"ratings: {len(ratings):,} players -> {rapm.OUT}")
    rows = players_table.build_rows()
    for r in rows[:8]:
        s = r["stats"]
        print(f"  {s['rank']:>3} {r['name']:<24} net {s['net']:+5.1f} (off {s['off']:+.1f}, def {s['def']:+.1f})")
    if a.no_publish:
        print("not published")
        return
    players_table.publish(rows)


if __name__ == "__main__":
    main()
