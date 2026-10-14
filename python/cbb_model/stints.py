"""
Rebuilds who was on the floor from ESPN play-by-play, giving one row per "stint" - a stretch of a game where the same ten
players were on the court - with its length and the points each team scored in it. This is the input to player ratings
(a regularised adjusted plus-minus, the same idea as the NHL shift model).

How: each team's five starters come from the box score; every Substitution play ("X subbing in for Duke") then moves one
player on or off. Between two substitutions the lineups are constant. A stint is kept only if both teams show exactly five
players for it; a game whose reconstruction drifts is reported (the share of its minutes that came out valid) and its bad
stretches are dropped rather than guessed at.

Possessions in a stint are estimated from its length and the game's pace (stint seconds / game seconds x game possessions) -
play-by-play does not tag possessions, and stints are short enough that this is close.

Usage:
    python -m cbb_model.stints --first 2018 --last 2025     # writes data/cbb/stints/stints_{season}.csv.gz
    python -m cbb_model.stints --test 40                    # reconstruct 40 games and print the quality
"""
from __future__ import annotations

import argparse
import re
import time

import pandas as pd

from .ingest import DATA_DIR, RAW_GAMES, read_gz

STINTS_DIR = DATA_DIR / "stints"
IN_RE = re.compile(r"subbing in", re.I)
OUT_RE = re.compile(r"subbing out", re.I)


def _clock_seconds(clk: str | None) -> float | None:
    if not clk:
        return None
    try:
        parts = clk.split(":")
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except ValueError:
        return None


def _elapsed(period: int, clk_s: float) -> float:
    """Seconds into the game. Halves are 20 minutes, overtimes 5."""
    if period == 1:
        return 1200.0 - clk_s
    if period == 2:
        return 1200.0 + (1200.0 - clk_s)
    return 2400.0 + (period - 3) * 300.0 + (300.0 - clk_s)


def build_game(game: dict, home_id: int, away_id: int, event_id: int, season: int, game_poss: float, minutes: float) -> tuple[list[dict], float]:
    """Stints for one game and the share of the game's seconds that were reconstructed cleanly."""
    starters: dict[int, set] = {home_id: set(), away_id: set()}
    for p in game.get("players", []):
        if p.get("starter") and p.get("id") is not None:
            tid = int(p["team_id"])
            if tid in starters:
                starters[tid].add(str(p["id"]))
    if len(starters[home_id]) != 5 or len(starters[away_id]) != 5:
        return [], 0.0

    plays = game.get("plays") or []
    on = {home_id: set(starters[home_id]), away_id: set(starters[away_id])}
    stints: list[dict] = []
    total = minutes * 60.0
    valid_secs = 0.0

    last_t = 0.0
    score_h, score_a = 0, 0
    seg_h0, seg_a0 = 0, 0  # scores at the start of the current stint

    def close(t_now: float) -> None:
        nonlocal last_t, seg_h0, seg_a0, valid_secs
        dur = t_now - last_t
        if dur > 0.5 and len(on[home_id]) == 5 and len(on[away_id]) == 5:
            stints.append(
                {
                    "event_id": event_id, "season": season, "home_id": home_id, "away_id": away_id, "t0": last_t, "dur": dur,
                    "poss": game_poss * dur / total, "pts_h": score_h - seg_h0, "pts_a": score_a - seg_a0,
                    **{f"h{i}": pid for i, pid in enumerate(sorted(on[home_id]))}, **{f"a{i}": pid for i, pid in enumerate(sorted(on[away_id]))},
                }
            )
            valid_secs += dur
        if dur > 0:
            last_t = t_now
        seg_h0, seg_a0 = score_h, score_a

    for p in plays:
        per = p.get("per")
        clk = _clock_seconds(p.get("clk"))
        if per is None or clk is None:
            continue
        t = _elapsed(int(per), clk)
        if p.get("hs") is not None and p.get("as") is not None:
            # score on a play is the running total AFTER it
            if t >= last_t:
                score_h, score_a = int(p["hs"]), int(p["as"])
        if p.get("t") == "Substitution" and p.get("tm") is not None:
            tid = int(p["tm"])
            if tid not in on:
                continue
            txt = p.get("txt") or ""
            who = [str(x) for x in (p.get("who") or []) if x is not None]
            if not who:
                continue
            if t > last_t:
                close(t)
            if OUT_RE.search(txt):
                for w in who:
                    on[tid].discard(w)
            elif IN_RE.search(txt):
                for w in who:
                    on[tid].add(w)
    close(total if last_t < total else last_t)
    return stints, min(valid_secs / total, 1.0)


def build_season(season: int, limit: int | None = None) -> tuple[pd.DataFrame, list[float]]:
    tg = pd.read_csv(DATA_DIR / "team_games.csv.gz", usecols=["event_id", "season", "team_id", "opp_id", "is_home", "poss", "ot"])
    tg = tg[(tg["season"] == season) & (tg["is_home"] == 1)]
    rows, quality = [], []
    t0 = time.time()
    for n, r in enumerate(tg.itertuples()):
        if limit and n >= limit:
            break
        path = RAW_GAMES / str(season) / f"{int(r.event_id)}.json.gz"
        if not path.exists():
            continue
        g = read_gz(path)
        if g.get("missing"):
            continue
        s, q = build_game(g, int(r.team_id), int(r.opp_id), int(r.event_id), season, float(r.poss), 40.0 + 5.0 * int(r.ot))
        quality.append(q)
        rows.extend(s)
        if (n + 1) % 1000 == 0:
            print(f"  {season}: {n + 1}/{len(tg)} games - {len(rows):,} stints - {time.time() - t0:.0f}s", flush=True)
    return pd.DataFrame(rows), quality


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2018)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--test", type=int, default=0, help="reconstruct this many games of --last and print the quality")
    a = ap.parse_args()
    STINTS_DIR.mkdir(parents=True, exist_ok=True)
    if a.test:
        df, q = build_season(a.last, limit=a.test)
        import numpy as np

        qa = np.array(q)
        print(f"{len(q)} games, {len(df):,} stints | valid share of game seconds: mean {qa.mean():.3f}, p10 {np.quantile(qa, 0.1):.3f}, games >=95%: {(qa >= 0.95).mean():.2%}")
        print("stints per game:", round(len(df) / max(len(q), 1), 1), "| avg stint seconds:", round(df["dur"].mean(), 1))
        by_game = df.groupby("event_id").agg(pts_h=("pts_h", "sum"), pts_a=("pts_a", "sum"))
        print(by_game.head(3).to_string())
        return
    for season in range(a.last, a.first - 1, -1):
        path = STINTS_DIR / f"stints_{season}.csv.gz"
        if path.exists():
            print(f"{season}: exists, skipping")
            continue
        df, q = build_season(season)
        df.to_csv(path, index=False)
        import numpy as np

        qa = np.array(q)
        print(f"{season}: {len(q):,} games, {len(df):,} stints, valid-seconds mean {qa.mean():.3f}, games >=95% {(qa >= 0.95).mean():.2%}", flush=True)


if __name__ == "__main__":
    main()
