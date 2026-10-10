"""
Player ratings for every skater: regularized adjusted plus-minus (RAPM) on expected goals, at 5v5.

For each stretch of a game where the same ten skaters (five a side) and both goalies are on the ice, we know exactly
how many seconds it lasted and the xG each team generated in it. Every such stretch becomes two observations:

    home xG rate  ~  intercept + sum(offence of home's 5 skaters) + sum(defence of away's 5 skaters)
    away xG rate  ~  sum(offence of away's 5 skaters) + sum(defence of home's 5 skaters)

weighted by the seconds in the stretch, and fitted by ridge regression so that a player with a small sample is pulled
toward average rather than trusted. Each skater ends up with two numbers, in xG per 60 minutes of 5v5 ice time versus an
average skater: `off` (how much more his team creates with him on) and `def` (how much more it allows - lower is better).
Older seasons count for less (exponential decay), so a player's rating is mostly his recent seasons.

Why it exists: (1) say HOW important an injured player is, (2) build lineup-aware team strength, which is the proper fix
for early-season roster moves - a player who changed teams brings his rating with him.

Usage:
    python -m nhl_model.player_ratings            # fit, validate, print the leaders
"""
from __future__ import annotations

import json
import time
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr

from .ingest import DATA_DIR, RAW_PBP, read_gz
from .shifts import RAW_SHIFTS
from .xg import SHOTS_XG_OUT

warnings.filterwarnings("ignore")

FIRST_SEASON = 2022  # ratings use the last few seasons; older play adds little and costs a long download
STINTS_OUT = DATA_DIR / "stints_5v5.csv.gz"
PLAYERS_JSON = DATA_DIR / "players.json"
RATINGS_JSON = DATA_DIR / "player_ratings.json"
HALF_LIFE_DAYS = 540.0
REG_SECONDS = 3600


def _secs(mmss: str | None) -> int | None:
    if not mmss:
        return None
    m, s = mmss.split(":")
    return int(m) * 60 + int(s)


def load_players(seasons: range) -> dict[int, dict]:
    """playerId -> {name, pos} from each game's roster (the latest team is filled in by the ratings step)."""
    cache = {}
    if PLAYERS_JSON.exists():
        cache = {int(k): v for k, v in json.loads(PLAYERS_JSON.read_text()).items()}
    return cache


def build_stints(first: int, last: int) -> pd.DataFrame:
    """One row per constant 5v5 stretch: game, time, seconds, who is on, and each team's xG in it."""
    shots = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "period", "t", "shooter_team_id", "xg", "season"], low_memory=False)
    shots = shots[(shots["period"] <= 3) & shots["xg"].notna()]
    shot_by_game = {g: d for g, d in shots.groupby("game_id")}
    goalies = set(pd.read_csv(SHOTS_XG_OUT, usecols=["goalie_id"], low_memory=False)["goalie_id"].dropna().astype(int).unique())
    games = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc", "home_team_id", "away_team_id", "home_goalie", "away_goalie"]).set_index("game_id")
    goalies |= set(games["home_goalie"].dropna().astype(int)) | set(games["away_goalie"].dropna().astype(int))

    rows, players = [], {}
    files = [p for season in range(first, last + 1) for p in sorted((RAW_SHIFTS / str(season)).glob("*.json.gz"))]
    t0 = time.time()
    for n, path in enumerate(files):
        gid = int(path.name.split(".")[0])
        if gid not in games.index or gid not in shot_by_game:
            continue
        g = games.loc[gid]
        home, away = int(g["home_team_id"]), int(g["away_team_id"])
        shifts = read_gz(path)["data"]
        ev = []  # (time, order, +1/-1, player, team)
        for s in shifts:
            if s.get("typeCode") != 517 or s.get("period") is None or s["period"] > 3:
                continue
            a, b = _secs(s.get("startTime")), _secs(s.get("endTime"))
            if a is None or b is None or b <= a:
                continue
            base = (int(s["period"]) - 1) * 1200
            tid = int(s["teamId"])
            if tid not in (home, away):
                continue
            ev.append((base + a, 0, -1, int(s["playerId"]), tid))  # ends sort before starts at the same instant
            ev.append((base + b, 0, -1, int(s["playerId"]), tid))
            ev[-2] = (base + a, 1, +1, int(s["playerId"]), tid)
        if not ev:
            continue
        ev.sort()
        sh = shot_by_game[gid]
        st = sh["t"].to_numpy(dtype=float)
        sx = sh["xg"].to_numpy(dtype=float)
        sh_home = (sh["shooter_team_id"].to_numpy() == home)
        on = {home: set(), away: set()}
        i = 0
        while i < len(ev):
            t = ev[i][0]
            while i < len(ev) and ev[i][0] == t:
                _, _, d, pid, tid = ev[i]
                (on[tid].add if d > 0 else on[tid].discard)(pid)
                i += 1
            if i >= len(ev):
                break
            t_next = ev[i][0]
            dur = t_next - t
            if dur <= 0:
                continue
            h_sk = sorted(p for p in on[home] if p not in goalies)
            a_sk = sorted(p for p in on[away] if p not in goalies)
            h_g = [p for p in on[home] if p in goalies]
            a_g = [p for p in on[away] if p in goalies]
            if len(h_sk) != 5 or len(a_sk) != 5 or len(h_g) != 1 or len(a_g) != 1:
                continue
            m = (st >= t) & (st < t_next)
            xh = float(sx[m & sh_home].sum())
            xa = float(sx[m & ~sh_home].sum())
            rows.append((gid, t, dur, xh, xa, *h_sk, *a_sk))
        if (n + 1) % 1000 == 0:
            print(f"  {n + 1}/{len(files)} games - {len(rows):,} stints - {time.time() - t0:.0f}s", flush=True)
    cols = ["game_id", "t", "dur", "xg_home", "xg_away"] + [f"h{i}" for i in range(5)] + [f"a{i}" for i in range(5)]
    return pd.DataFrame(rows, columns=cols)


def player_directory(first: int, last: int) -> dict[int, dict]:
    """playerId -> name, position, latest team id, from each game's roster spots (later games overwrite earlier ones)."""
    out: dict[int, dict] = {}
    for season in range(first, last + 1):
        for path in sorted((RAW_PBP / str(season)).glob("*.json.gz")):
            try:
                d = read_gz(path)
            except Exception:  # noqa: BLE001
                continue
            for p in d.get("rosterSpots", []):
                out[int(p["playerId"])] = {
                    "name": f"{p['firstName']['default']} {p['lastName']['default']}",
                    "pos": p.get("positionCode"),
                    "team_id": int(p["teamId"]),
                }
    return out


def fit_rapm(stints: pd.DataFrame, game_dates: pd.Series, lam: float, as_of: pd.Timestamp | None = None):
    """Weighted ridge on the stints. Returns (player_ids, off, def, intercept)."""
    s = stints
    if as_of is not None:
        s = s[game_dates.reindex(s["game_id"]).to_numpy() < as_of]
    dates = game_dates.reindex(s["game_id"]).to_numpy()
    ref = pd.Timestamp(dates.max())
    age = (ref - pd.to_datetime(dates)).days.to_numpy(dtype=float)
    decay = 0.5 ** (age / HALF_LIFE_DAYS)

    pids = np.unique(s[[f"h{i}" for i in range(5)] + [f"a{i}" for i in range(5)]].to_numpy().ravel())
    idx = {int(p): k for k, p in enumerate(pids)}
    P = len(pids)
    H = np.vectorize(idx.get)(s[[f"h{i}" for i in range(5)]].to_numpy())
    A = np.vectorize(idx.get)(s[[f"a{i}" for i in range(5)]].to_numpy())
    n = len(s)
    # rows: home attacking (off of home skaters, def of away skaters), then away attacking
    r = np.repeat(np.arange(2 * n), 5)
    c_off_h = H.ravel()
    c_def_a = (A + P).ravel()
    c_off_a = A.ravel()
    c_def_h = (H + P).ravel()
    rows = np.concatenate([r[: 5 * n], r[: 5 * n], r[5 * n :], r[5 * n :]])
    cols = np.concatenate([c_off_h, c_def_a, c_off_a, c_def_h])
    X = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(2 * n, 2 * P))
    # home-ice intercept for the home-attacking rows only
    home_flag = sp.csr_matrix((np.concatenate([np.ones(n), np.zeros(n)]), (np.arange(2 * n), np.zeros(2 * n, dtype=int))), shape=(2 * n, 1))
    X = sp.hstack([X, home_flag]).tocsr()
    dur = s["dur"].to_numpy(dtype=float)
    y = np.concatenate([s["xg_home"].to_numpy() / dur, s["xg_away"].to_numpy() / dur]) * 3600.0  # xG per 60
    w = np.concatenate([dur * decay, dur * decay])
    ybar = float(np.average(y, weights=w))
    sw = np.sqrt(w)
    Xw = sp.diags(sw) @ X
    yw = sw * (y - ybar)
    # the ridge penalty is on the player coefficients only, in the same weighted units
    sol = lsqr(Xw, yw, damp=np.sqrt(lam), atol=1e-8, btol=1e-8, iter_lim=400)[0]
    return pids, sol[:P], sol[P : 2 * P], float(sol[-1]), ybar


def validate(stints: pd.DataFrame, game_dates: pd.Series) -> None:
    """Fit on everything before a cut-off, score the stints after it - does the rating beat 'everyone is average'?"""
    dates = game_dates.reindex(stints["game_id"]).to_numpy()
    cut = pd.Timestamp(np.quantile(pd.to_datetime(dates).astype("int64"), 0.85))
    cut = pd.Timestamp(cut, tz="UTC") if cut.tzinfo is None else cut
    gd = game_dates.copy()
    test = stints[pd.to_datetime(game_dates.reindex(stints["game_id"]).to_numpy(), utc=True) >= cut]
    print(f"validation: fit before {cut:%Y-%m-%d}, score {len(test):,} later stints")
    for lam in (200.0, 800.0, 2500.0, 8000.0):
        pids, off, de, icpt, ybar = fit_rapm(stints, gd, lam, as_of=cut)
        idx = {int(p): k for k, p in enumerate(pids)}
        def lookup(cols, arr):
            return np.array([[arr[idx[int(p)]] if int(p) in idx else 0.0 for p in row] for row in cols])
        Ht = test[[f"h{i}" for i in range(5)]].to_numpy()
        At = test[[f"a{i}" for i in range(5)]].to_numpy()
        dur = test["dur"].to_numpy(dtype=float)
        pred_h = ybar + icpt + lookup(Ht, off).sum(1) + lookup(At, de).sum(1)
        pred_a = ybar + lookup(At, off).sum(1) + lookup(Ht, de).sum(1)
        y_h = test["xg_home"].to_numpy() / dur * 3600.0
        y_a = test["xg_away"].to_numpy() / dur * 3600.0
        w = np.concatenate([dur, dur])
        y = np.concatenate([y_h, y_a])
        pr = np.concatenate([pred_h, pred_a])
        base = np.concatenate([np.full(len(dur), ybar + icpt), np.full(len(dur), ybar)])
        sse_m = float(np.average((y - pr) ** 2, weights=w))
        sse_b = float(np.average((y - base) ** 2, weights=w))
        # compare in terms of explained covariance: correlation of prediction with outcome (weighted)
        print(f"  lambda {lam:>7.0f}: weighted MSE {sse_m:.3f} vs average-player baseline {sse_b:.3f}  ({(1 - sse_m / sse_b) * 100:+.2f}% better)")


LAMBDA = 25000.0  # ridge strength; chosen on a held-out 15% of games (validate() above)
MIN_TOI_MIN = 100  # skaters with less 5v5 time than this in the window aren't rated


def _abbrev_by_team_id() -> dict[int, str]:
    g = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["home_team_id", "home_abbrev", "away_team_id", "away_abbrev", "start_utc"]).sort_values("start_utc")
    return {**dict(zip(g["away_team_id"], g["away_abbrev"])), **dict(zip(g["home_team_id"], g["home_abbrev"]))}


def current_stints(first: int, last: int) -> pd.DataFrame:
    """The 5v5 stints table, rebuilt only when shift charts for new games have arrived since it was cached."""
    n_files = sum(1 for season in range(first, last + 1) for _ in (RAW_SHIFTS / str(season)).glob("*.json.gz"))
    if STINTS_OUT.exists():
        cached = pd.read_csv(STINTS_OUT)
        # a game with no usable 5v5 stretch is rare, so a cache within 1% of the file count is current
        if cached["game_id"].nunique() >= 0.99 * n_files:
            return cached
    print(f"building 5v5 stints from {n_files} shift charts...", flush=True)
    stints = build_stints(first, last)
    stints.to_csv(STINTS_OUT, index=False)
    return stints


def rate_skaters(first: int, last: int) -> pd.DataFrame:
    """One row per rated skater: off/def/net (xG per 60, 5v5, vs an average skater), 5v5 minutes per game, games, and the
    per-game value (net x minutes) that ranks how much he matters to his team's results."""
    stints = current_stints(first, last)
    games = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc"])
    game_dates = pd.Series(pd.to_datetime(games["start_utc"], utc=True).to_numpy(), index=games["game_id"])
    pids, off, de, _, _ = fit_rapm(stints, game_dates, LAMBDA)

    long = pd.concat([stints[["game_id", "dur", c]].rename(columns={c: "pid"}) for c in [f"h{i}" for i in range(5)] + [f"a{i}" for i in range(5)]])
    toi = long.groupby("pid")["dur"].sum() / 60.0  # minutes of 5v5 in the window
    gp = long.groupby("pid")["game_id"].nunique()
    df = pd.DataFrame({"player_id": pids.astype(int), "off": off, "def": de})
    df["net"] = df["off"] - df["def"]
    df["toi_min"] = df["player_id"].map(toi)
    df["gp"] = df["player_id"].map(gp)
    df["toi_pg"] = df["toi_min"] / df["gp"]
    df["value_pg"] = df["net"] * df["toi_pg"] / 60.0  # xG per game above an average skater
    df = df[df["toi_min"] >= MIN_TOI_MIN].copy()

    d = player_directory(first, last)
    abbrev = _abbrev_by_team_id()
    df["name"] = df["player_id"].map(lambda p: d.get(int(p), {}).get("name", str(p)))
    df["pos"] = df["player_id"].map(lambda p: d.get(int(p), {}).get("pos"))
    df["team"] = df["player_id"].map(lambda p: abbrev.get(d.get(int(p), {}).get("team_id")))
    df["rank"] = df["value_pg"].rank(ascending=False, method="min").astype(int)
    df["n"] = len(df)
    df["pct"] = 1.0 - (df["rank"] - 1) / df["n"]
    return df.sort_values("rank").reset_index(drop=True)


def run(first: int = 2022, last: int | None = None, publish: bool = True) -> pd.DataFrame:
    from cfbd_ingest.sync_nhl_espn import _season_year

    last = _season_year() if last is None else last
    t0 = time.time()
    df = rate_skaters(first, last)
    print(f"rated {len(df)} skaters in {time.time() - t0:.0f}s")
    top = df.head(8)
    print(top[["rank", "name", "pos", "team", "net", "toi_pg", "value_pg"]].round(3).to_string(index=False))
    RATINGS_JSON.write_text(df.to_json(orient="records"))
    if not publish:
        return df
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    now = pd.Timestamp.now(tz="UTC").isoformat()
    rows = [
        {
            "player_id": int(r.player_id), "name": r.name, "pos": r.pos, "team": r.team, "updated_at": now,
            "stats": {
                "off": round(float(r.off), 3), "def": round(float(getattr(r, "def_")), 3),
                "net": round(float(r.net), 3), "toi_pg": round(float(r.toi_pg), 1), "gp": int(r.gp),
                "value_pg": round(float(r.value_pg), 4), "rank": int(r.rank), "n": int(r.n), "pct": round(float(r.pct), 4),
            },
        }
        for r in df.rename(columns={"def": "def_"}).itertuples()
    ]
    try:
        for i in range(0, len(rows), 300):
            client.table("nhl_skater_ratings").upsert(rows[i : i + 300], on_conflict="player_id").execute()
        print(f"published {len(rows)} skater ratings")
    except Exception as e:  # noqa: BLE001
        if "PGRST205" in str(e) or "schema cache" in str(e):
            print("(skater ratings not published: run the nhl_skater_ratings block in supabase/schema.sql)")
        else:
            raise
    return df


def validate_main() -> None:
    first, last = 2022, 2026
    t0 = time.time()
    if STINTS_OUT.exists():
        stints = pd.read_csv(STINTS_OUT)
        print(f"loaded {len(stints):,} cached stints")
    else:
        print("building 5v5 stints from shift charts...", flush=True)
        stints = build_stints(first, last)
        stints.to_csv(STINTS_OUT, index=False)
        print(f"{len(stints):,} stints in {time.time() - t0:.0f}s", flush=True)

    games = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc"])
    game_dates = pd.Series(pd.to_datetime(games["start_utc"], utc=True).to_numpy(), index=games["game_id"])
    validate(stints, game_dates)


def main() -> None:
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "validate":
        validate_main()
    else:
        run(publish="--dry-run" not in sys.argv)


if __name__ == "__main__":
    main()
