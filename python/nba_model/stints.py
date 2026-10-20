"""
Rebuilds who was on the floor in every NBA game from ESPN's play-by-play: one row per "stint" - a stretch where the same ten
players were on the court - with its length and the points each team scored in it. The input to player ratings (lineup RAPM).

How: each team's five starters come from the box score; every Substitution play ("A enters the game for B", with both players'
ids) then swaps one player. Between two substitutions the lineups are constant. A stint is kept only if both teams show exactly
five players; a game whose reconstruction drifts is reported (the share of its seconds that came out valid) and the bad stretches
are dropped rather than guessed at. Possessions in a stint are estimated from its length and the game's pace.

    python -m nba_model.stints --test 60            # reconstruct 60 games and print the quality
    python -m nba_model.stints                      # writes data/nba/stints/stints_{season}.csv.gz for every season pulled
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd

from cbb_model.ingest import read_gz
from .ingest import DATA_DIR, RAW_GAMES, RAW_PBP

STINTS_DIR = DATA_DIR / "stints"


def _elapsed(period: int, clk_s: float) -> float:
    """Seconds into the game. Quarters are 12 minutes, overtimes 5."""
    if period <= 4:
        return (period - 1) * 720.0 + (720.0 - clk_s)
    return 2880.0 + (period - 5) * 300.0 + (300.0 - clk_s)


def build_game(box: dict, plays: list[dict], home_id: int, away_id: int, event_id: int, season: int, game_poss: float, minutes: float) -> tuple[list[dict], float, dict]:
    """Stints for one game, the share of its seconds reconstructed cleanly, and each player's reconstructed seconds."""
    starters: dict[int, set] = {home_id: set(), away_id: set()}
    for p in box.get("players", []):
        if p.get("starter") and p.get("id") is not None:
            tid = int(p["team_id"])
            if tid in starters:
                starters[tid].add(str(p["id"]))
    if len(starters[home_id]) != 5 or len(starters[away_id]) != 5:
        return [], 0.0, {}

    on = {home_id: set(starters[home_id]), away_id: set(starters[away_id])}
    stints: list[dict] = []
    total = minutes * 60.0
    valid_secs = 0.0
    secs: dict[str, float] = {}
    last_t = 0.0
    score_h = score_a = 0
    seg_h0 = seg_a0 = 0

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
            for pid in list(on[home_id]) + list(on[away_id]):
                secs[pid] = secs.get(pid, 0.0) + dur
        if dur > 0:
            last_t = t_now
        seg_h0, seg_a0 = score_h, score_a

    cur_t = 0.0  # the latest game time seen; a play with no clock (a few substitutions have none) happens at that moment
    for p in plays:
        per, clk = p.get("per"), p.get("clk")
        if per is None or clk is None:
            if p.get("t") != "Substitution":
                continue
            t = cur_t
        else:
            t = _elapsed(int(per), float(clk))
            cur_t = max(cur_t, t)
        if p.get("hs") is not None and p.get("as") is not None and t >= last_t:
            score_h, score_a = int(p["hs"]), int(p["as"])  # the running score AFTER this play
        if p.get("t") == "Substitution" and p.get("tm") is not None:
            tid = int(p["tm"])
            who = [str(x) for x in (p.get("who") or []) if x is not None]
            if tid not in on or len(who) < 2:
                continue
            if t > last_t:
                close(t)
            incoming, outgoing = who[0], who[1]
            on[tid].discard(outgoing)
            on[tid].add(incoming)
    close(total if last_t < total else last_t)
    return stints, min(valid_secs / total, 1.0), secs


def build_season(season: int, limit: int | None = None) -> tuple[pd.DataFrame, list[float], list[float]]:
    tg = pd.read_csv(DATA_DIR / "team_games.csv.gz", usecols=["event_id", "season", "team_id", "opp_id", "is_home", "poss", "ot"])
    tg = tg[(tg["season"] == season) & (tg["is_home"] == 1)]
    pg = pd.read_csv(DATA_DIR / "player_games.csv.gz", usecols=["event_id", "player_id", "min"])
    box_min = {(int(e), str(int(p))): m for e, p, m in zip(pg.event_id, pg.player_id, pg["min"]) if p == p}
    rows, quality, minute_err = [], [], []
    t0 = time.time()
    for n, r in enumerate(tg.itertuples()):
        if limit and n >= limit:
            break
        bpath = RAW_GAMES / str(season) / f"{int(r.event_id)}.json.gz"
        ppath = RAW_PBP / str(season) / f"{int(r.event_id)}.json.gz"
        if not bpath.exists() or not ppath.exists():
            continue
        box, pbp = read_gz(bpath), read_gz(ppath)
        if box.get("missing") or pbp.get("missing"):
            continue
        s, q, secs = build_game(box, pbp.get("plays") or [], int(r.team_id), int(r.opp_id), int(r.event_id), season, float(r.poss), 48.0 + 5.0 * int(r.ot))
        quality.append(q)
        rows.extend(s)
        for pid, sec in secs.items():  # reconstructed minutes vs the box score, for players with real minutes
            bm = box_min.get((int(r.event_id), str(pid)))
            if bm and bm >= 12:
                minute_err.append(abs(sec / 60.0 - bm))
        if (n + 1) % 500 == 0:
            print(f"  {season}: {n + 1}/{len(tg)} games - {len(rows):,} stints - {time.time() - t0:.0f}s", flush=True)
    return pd.DataFrame(rows), quality, minute_err


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2021)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--test", type=int, default=0)
    a = ap.parse_args()
    STINTS_DIR.mkdir(parents=True, exist_ok=True)
    if a.test:
        df, q, me = build_season(a.last, limit=a.test)
        qa = np.array(q)
        print(f"{len(q)} games, {len(df):,} stints | valid share of game seconds: mean {qa.mean():.3f}, p10 {np.quantile(qa, 0.1):.3f}, games >=95%: {(qa >= 0.95).mean():.2%}")
        print(f"stints per game {len(df) / max(len(q), 1):.1f} | avg stint {df['dur'].mean():.0f}s | reconstructed vs box minutes (players with 12+ min): mean abs error {np.mean(me):.2f} min, within 1.0 min {np.mean(np.array(me) <= 1.0):.1%}")
        by = df.groupby("event_id").agg(h=("pts_h", "sum"), a=("pts_a", "sum")).head(3)
        print(by.to_string())
        return
    for season in range(a.last, a.first - 1, -1):
        path = STINTS_DIR / f"stints_{season}.csv.gz"
        if path.exists():
            print(f"{season}: exists, skipping")
            continue
        df, q, me = build_season(season)
        df.to_csv(path, index=False)
        qa = np.array(q)
        print(f"{season}: {len(q):,} games, {len(df):,} stints, valid-seconds mean {qa.mean():.3f}, games >=95% {(qa >= 0.95).mean():.2%}, minute error {np.mean(me):.2f}", flush=True)


if __name__ == "__main__":
    main()
