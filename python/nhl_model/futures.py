"""
Season simulation: each team's chance to win its division, make the playoffs, win each round, the conference, and the Cup.

Plays the rest of the regular season thousands of times and then the NHL playoff bracket:

  per game      the game simulator (sim.py) gives six outcomes for every remaining game from each team's current rates
                and goalie: regulation win (either side), overtime win (either side), shootout win (either side) - so
                standings points, regulation wins (RW) and regulation+overtime wins (ROW) all come out right
  uncertainty   a team's true strength isn't known exactly, so every simulated season each team gets its own random
                strength shift (a normal added to the logit of every game it plays; SIGMA below, set from the midseason
                back-test in futures_validate.py). Without it the favourites' odds come out far too confident.
  standings     points, then regulation wins, then ROW, then goal differential, then a coin flip (head-to-head, the next
                official tiebreaker, is not modelled)
  playoffs      top three in each division + two wild cards per conference (next best by points), the division winner
                with the better record meets the LOWER wild card, 2nd v 3rd inside each division, then the division
                final, conference final and Cup final; best-of-7 with 2-2-1-1-1 home ice for the better regular-season
                record, each game from the same game simulator

    python -m nhl_model.futures --dry-run
"""
from __future__ import annotations

import argparse
import json
import time
import warnings

import numpy as np
import pandas as pd

from .ingest import DATA_DIR, SCHEDULE_CSV

warnings.filterwarnings("ignore")

FUTURES_JSON = DATA_DIR / "futures.json"
# sd of each team's strength shift, in logit units of a single game. The midseason back-test (futures_validate.py, 320
# team-checkpoints) preferred ~0 for making the playoffs - the per-game randomness already carries the uncertainty - but a
# small value is kept because a best-of-7 amplifies any rating error and playoff rounds can't be tested that way.
SIGMA = 0.05
PAIR_SIMS = 3000
GAME_SIMS = 3000

# Conference / division for the current alignment (2026-27).
DIVISIONS: dict[str, tuple[str, str]] = {}
for _div, _conf, _teams in (
    ("Atlantic", "East", "BOS BUF DET FLA MTL OTT TBL TOR"),
    ("Metropolitan", "East", "CAR CBJ NJD NYI NYR PHI PIT WSH"),
    ("Central", "West", "CHI COL DAL MIN NSH STL UTA WPG"),
    ("Pacific", "West", "ANA CGY EDM LAK SEA SJS VAN VGK"),
):
    for _t in _teams.split():
        DIVISIONS[_t] = (_conf, _div)


# ------------------------------------------------------------------ inputs

def standings(season: int, as_of: pd.Timestamp | None = None) -> pd.DataFrame:
    """Points, regulation wins, ROW, goal differential and games played per team from the completed games of a season."""
    tg = pd.read_csv(DATA_DIR / "team_games.csv.gz", usecols=["game_id", "season", "team_id", "start_utc", "final_for", "final_against", "last_period"])
    tg = tg[tg["season"] == season]
    if as_of is not None:
        tg = tg[pd.to_datetime(tg["start_utc"], utc=True) < as_of]
    won = tg["final_for"] > tg["final_against"]
    tg = tg.assign(
        pts=2 * won + ((~won) & (tg["last_period"] != "REG")),
        rw=(won & (tg["last_period"] == "REG")).astype(int),
        row=(won & tg["last_period"].isin(["REG", "OT"])).astype(int),
        gd=tg["final_for"] - tg["final_against"],
    )
    return tg.groupby("team_id").agg(gp=("pts", "size"), pts=("pts", "sum"), rw=("rw", "sum"), row=("row", "sum"), gd=("gd", "sum"))


def abbrev_by_id() -> dict[int, str]:
    s = pd.read_csv(SCHEDULE_CSV, usecols=["home_abbrev", "away_abbrev", "home_team_id", "away_team_id"])
    return {**dict(zip(s["away_team_id"], s["away_abbrev"])), **dict(zip(s["home_team_id"], s["home_abbrev"]))}


def game_outcomes(fit, tb, simulate, home_id: int, away_id: int, g_home: float, g_away: float, n: int, seed: int) -> np.ndarray:
    """P(home regulation win, home OT win, home shootout win, away OT win, away SO win, away regulation win)."""
    s = simulate(fit.params(home_id, away_id, g_home, g_away), tb, n, seed=seed)
    hw = s["fin_h"] > s["fin_a"]
    reg_h, reg_a = s["reg_h"] > s["reg_a"], s["reg_a"] > s["reg_h"]
    tie, so = s["tie"], s["so"]
    ot = tie & ~so
    out = np.array([
        reg_h.mean(), (ot & hw).mean(), (so & hw).mean(),
        (ot & ~hw).mean(), (so & ~hw).mean(), reg_a.mean(),
    ])
    return out / out.sum()


# ------------------------------------------------------------------ the simulation

def series_win_prob(p_home_ice_at_home: float, p_home_ice_on_road: float) -> float:
    """Best-of-7, 2-2-1-1-1: probability the home-ice team wins. Inputs are ITS win probability at home and on the road."""
    venues = [True, True, False, False, True, False, True]
    # dp[w][l] = probability of reaching that state
    dp = {(0, 0): 1.0}
    win = 0.0
    for g in range(7):
        nxt: dict[tuple[int, int], float] = {}
        p = p_home_ice_at_home if venues[g] else p_home_ice_on_road
        for (w, l), pr in dp.items():
            if w == 4 or l == 4:
                continue
            nxt[(w + 1, l)] = nxt.get((w + 1, l), 0.0) + pr * p
            nxt[(w, l + 1)] = nxt.get((w, l + 1), 0.0) + pr * (1 - p)
        dp = {k: v for k, v in nxt.items()}
        for (w, l), pr in list(dp.items()):
            if w == 4:
                win += pr
                del dp[(w, l)]
            elif l == 4:
                del dp[(w, l)]
    return win


def simulate_season(
    teams: list[str],
    st: pd.DataFrame,  # indexed by team abbrev: gp, pts, rw, row, gd
    games: list[tuple[str, str, np.ndarray]],  # remaining: (home, away, 6 outcome probs)
    pair_home_win: np.ndarray,  # [i, j] = P(team i beats team j) when i hosts
    n_sims: int = 10000,
    sigma: float = SIGMA,
    seed: int = 1,
    chunk: int = 2500,
) -> dict[str, dict[str, np.ndarray]]:
    rng = np.random.default_rng(seed)
    T = len(teams)
    idx = {t: i for i, t in enumerate(teams)}
    conf = np.array([DIVISIONS[t][0] == "East" for t in teams])
    div_names = sorted({d for _, d in DIVISIONS.values()})
    div_id = np.array([div_names.index(DIVISIONS[t][1]) for t in teams])
    R = len(games)
    hi = np.array([idx[h] for h, _, _ in games], dtype=int)
    ai = np.array([idx[a] for _, a, _ in games], dtype=int)
    probs = np.array([p for _, _, p in games]) if R else np.zeros((0, 6))
    p_hw = probs[:, :3].sum(1) if R else np.zeros(0)
    # conditional outcome mixes given the winner
    cond_h = probs[:, :3] / np.maximum(p_hw[:, None], 1e-9) if R else probs[:, :3]
    cond_a = probs[:, [5, 3, 4]] / np.maximum(1 - p_hw[:, None], 1e-9) if R else probs[:, :3]  # away win: [reg, ot, so]

    base_pts = st.reindex(teams)[["pts", "rw", "row", "gd"]].fillna(0).to_numpy(dtype=float)
    # series win probabilities for every ordered (home-ice team i, opponent j)
    S = np.zeros((T, T))
    for i in range(T):
        for j in range(T):
            if i != j:
                S[i, j] = series_win_prob(pair_home_win[i, j], 1.0 - pair_home_win[j, i])

    counts = {k: np.zeros(T) for k in ("playoffs", "division", "r2", "r3", "final", "cup")}
    pts_sum = np.zeros(T)
    pts_sq = np.zeros(T)
    done = 0
    while done < n_sims:
        m = min(chunk, n_sims - done)
        delta = rng.normal(0.0, sigma, (m, T))
        pts = np.repeat(base_pts[None, :, 0], m, axis=0)
        rw = np.repeat(base_pts[None, :, 1], m, axis=0)
        row = np.repeat(base_pts[None, :, 2], m, axis=0)
        gd = np.repeat(base_pts[None, :, 3], m, axis=0)
        if R:
            u = rng.random((m, R))
            v = rng.random((m, R))
            shift = delta[:, hi] - delta[:, ai]
            logit = np.log(np.clip(p_hw, 1e-6, 1 - 1e-6) / np.clip(1 - p_hw, 1e-6, 1))[None, :] + shift
            p_home = 1 / (1 + np.exp(-logit))
            home_win = u < p_home
            # winner subtype: 0 regulation, 1 overtime, 2 shootout
            ch = cond_h[None, :, :]
            ca = cond_a[None, :, :]
            vc_h = (v[:, :, None] > np.cumsum(ch, axis=2)[:, :, :2]).sum(2)
            vc_a = (v[:, :, None] > np.cumsum(ca, axis=2)[:, :, :2]).sum(2)
            sub = np.where(home_win, vc_h, vc_a)
            home_pts = np.where(home_win, 2, np.where(sub > 0, 1, 0))
            away_pts = np.where(home_win, np.where(sub > 0, 1, 0), 2)
            home_rw = (home_win & (sub == 0)).astype(int)
            away_rw = ((~home_win) & (sub == 0)).astype(int)
            home_row = (home_win & (sub <= 1)).astype(int)
            away_row = ((~home_win) & (sub <= 1)).astype(int)
            for arr, h_add, a_add in ((pts, home_pts, away_pts), (rw, home_rw, away_rw), (row, home_row, away_row)):
                for t in range(T):
                    arr[:, t] += h_add[:, hi == t].sum(1) + a_add[:, ai == t].sum(1)
            # goal differential isn't simulated game by game; a small random tiebreak stands in for it
        key = pts * 1e6 + rw * 1e3 + row + gd * 1e-3 + rng.random((m, T)) * 1e-4
        pts_sum += pts.sum(0)
        pts_sq += (pts**2).sum(0)

        # --- standings -> playoff field, per conference
        qualified = np.zeros((m, T), dtype=bool)
        div_win = np.zeros((m, T), dtype=bool)
        seeds: dict[bool, dict[str, np.ndarray]] = {}
        for east in (True, False):
            tids = np.where(conf == east)[0]
            kk = key[:, tids]
            div_top = {}
            taken = np.zeros((m, len(tids)), dtype=bool)
            for d in sorted(set(div_id[tids])):
                cols = np.where(div_id[tids] == d)[0]
                order = np.argsort(-kk[:, cols], axis=1)[:, :3]
                top = cols[order]  # (m, 3) column indexes within tids
                div_top[d] = top
                for k in range(3):
                    taken[np.arange(m), top[:, k]] = True
                div_win[np.arange(m)[:, None], tids[top[:, :1]]] = True
            rest = np.where(taken, -np.inf, kk)
            wc = np.argsort(-rest, axis=1)[:, :2]
            for d, top in div_top.items():
                for k in range(3):
                    qualified[np.arange(m), tids[top[:, k]]] = True
            for k in range(2):
                qualified[np.arange(m), tids[wc[:, k]]] = True
            seeds[east] = {"tids": tids, "div_top": div_top, "wc": wc, "kk": kk}

        counts["playoffs"] += qualified.sum(0)
        counts["division"] += div_win.sum(0)

        # --- bracket
        champs = []
        for east in (True, False):
            info = seeds[east]
            tids, div_top, wc, kk = info["tids"], info["div_top"], info["wc"], info["kk"]
            ds = sorted(div_top)
            d1, d2 = div_top[ds[0]], div_top[ds[1]]
            w1, w2 = tids[d1[:, 0]], tids[d2[:, 0]]  # division winners (team ids, shape m)
            better_first = key[np.arange(m), w1] >= key[np.arange(m), w2]
            top_w = np.where(better_first, w1, w2)  # best record among division winners -> faces the LOWER wild card
            low_w = np.where(better_first, w2, w1)
            wc_hi, wc_lo = tids[wc[:, 0]], tids[wc[:, 1]]
            ar = np.arange(m)

            def play(a, b):
                """Series between team ids a and b (arrays); the better regular-season record has home ice."""
                a_home = key[ar, a] >= key[ar, b]
                home, away = np.where(a_home, a, b), np.where(a_home, b, a)
                home_wins = rng.random(m) < S[home, away]
                return np.where(home_wins, home, away), home_wins

            # first round: top division winner v lower wild card, other winner v upper wild card, 2v3 in each division
            ser = {}
            ser["A"] = play(top_w, wc_lo)[0]
            ser["B"] = play(low_w, wc_hi)[0]
            g1 = {ds[0]: None, ds[1]: None}
            # which wild-card series sits in which division: the series whose division winner is the division's 1st
            d_of_top = np.where(better_first, 0, 1)  # index (into ds) of the division winner who is top_w
            a_in_d0 = d_of_top == 0
            # pairs inside divisions
            c1 = play(tids[d1[:, 1]], tids[d1[:, 2]])[0]
            c2 = play(tids[d2[:, 1]], tids[d2[:, 2]])[0]
            # round-1 survivors: bracket per division = (division winner's series) v (2v3 series)
            w_d0_series = np.where(a_in_d0, ser["A"], ser["B"])
            w_d1_series = np.where(a_in_d0, ser["B"], ser["A"])
            for t_arr in (w_d0_series, w_d1_series, c1, c2):
                np.add.at(counts["r2"], t_arr, 1)
            f0 = play(w_d0_series, c1)[0]
            f1 = play(w_d1_series, c2)[0]
            np.add.at(counts["r3"], f0, 1)
            np.add.at(counts["r3"], f1, 1)
            champ = play(f0, f1)[0]
            np.add.at(counts["final"], champ, 1)
            champs.append(champ)
        # Cup final between the two conference champions
        a, b = champs
        a_home = key[np.arange(m), a] >= key[np.arange(m), b]
        home, away = np.where(a_home, a, b), np.where(a_home, b, a)
        cup = np.where(rng.random(m) < S[home, away], home, away)
        np.add.at(counts["cup"], cup, 1)
        done += m

    out = {k: v / n_sims for k, v in counts.items()}
    mean = pts_sum / n_sims
    out["exp_pts"] = mean
    out["sd_pts"] = np.sqrt(np.maximum(pts_sq / n_sims - mean**2, 0))
    return out


def american(p: float) -> int | None:
    if p <= 0.0005 or p >= 0.9995:
        return None
    return int(round(-100 * p / (1 - p))) if p >= 0.5 else int(round(100 * (1 - p) / p))


# ------------------------------------------------------------------ production run

def run(dry_run: bool = False, n_sims: int = 10000, sigma: float = SIGMA) -> list[dict]:
    from .goalie_model import build_tracker
    from .publish import recent_starters
    from .sim import SimConfig, load_tables, simulate
    from .sim_backtest import GOALIE_PRIOR_ATTEMPTS, fit_block, load_sim_team_games
    from cfbd_ingest.sync_nhl_espn import _season_year

    t0 = time.time()
    season = _season_year()
    now = pd.Timestamp.now(tz="UTC")
    sched = pd.read_csv(SCHEDULE_CSV)
    sched["t"] = pd.to_datetime(sched["start_utc"], utc=True)
    sched = sched[sched["season"] == season]
    remaining = sched[sched["game_state"].isin(["FUT", "PRE", "LIVE", "CRIT"])]
    ab = abbrev_by_id()
    st = standings(season)
    st.index = [ab.get(i, str(i)) for i in st.index]
    teams = sorted(DIVISIONS)

    tb = load_tables()
    tracker, gr = build_tracker(GOALIE_PRIOR_ATTEMPTS)
    tg = load_sim_team_games(gr)
    fit = fit_block(tg, now, SimConfig(use_goalie=True), tb)
    if fit is None:
        raise SystemExit("not enough history to fit")
    games_df = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc", "home_team_id", "away_team_id", "home_goalie", "away_goalie"])
    games_df["t"] = pd.to_datetime(games_df["start_utc"], utc=True)
    ids = {v: k for k, v in ab.items()}

    def main_goalie_rating(team: str) -> float:
        starters = recent_starters(games_df, int(ids[team]), now, k=20)
        if not starters:
            return 0.0
        from collections import Counter

        g = Counter(g for g, _ in starters).most_common(1)[0][0]
        return float(tracker.rating(g, now))

    rating = {t: main_goalie_rating(t) for t in teams}

    games: list[tuple[str, str, np.ndarray]] = []
    for k, r in enumerate(remaining.itertuples()):
        h, a = r.home_abbrev, r.away_abbrev
        if h not in DIVISIONS or a not in DIVISIONS:
            continue
        games.append((h, a, game_outcomes(fit, tb, simulate, int(r.home_team_id), int(r.away_team_id), rating[h], rating[a], GAME_SIMS, 1000 + k)))
    print(f"{len(games)} remaining games priced in {time.time() - t0:.0f}s", flush=True)

    P = np.zeros((len(teams), len(teams)))
    for i, h in enumerate(teams):
        for j, a in enumerate(teams):
            if i != j:
                o = game_outcomes(fit, tb, simulate, int(ids[h]), int(ids[a]), rating[h], rating[a], PAIR_SIMS, 50_000 + i * 40 + j)
                P[i, j] = o[:3].sum()
    print(f"playoff matchup table built in {time.time() - t0:.0f}s", flush=True)

    res = simulate_season(teams, st, games, P, n_sims=n_sims, sigma=sigma)
    rows = []
    for i, t in enumerate(teams):
        conf, div = DIVISIONS[t]
        row = {"team": t, "conference": conf, "div_name": div, "gp": int(st.loc[t, "gp"]) if t in st.index else 0, "pts": int(st.loc[t, "pts"]) if t in st.index else 0}
        for k in ("division", "playoffs", "r2", "r3", "final", "cup"):
            p = float(res[k][i])
            row[k] = round(p, 4)
            row[f"{k}_odds"] = american(p)
        row["exp_pts"] = round(float(res["exp_pts"][i]), 1)
        row["sd_pts"] = round(float(res["sd_pts"][i]), 1)
        rows.append(row)
    rows.sort(key=lambda r: -r["cup"])
    FUTURES_JSON.write_text(json.dumps({"season": season, "n_sims": n_sims, "sigma": sigma, "generated_at": now.isoformat(), "teams": rows}))
    print(f"\n{'team':<5}{'GP':>3}{'Pts':>4}{'xPts':>6}{'Div%':>7}{'Playoff%':>9}{'R2%':>6}{'CF%':>6}{'Final%':>7}{'Cup%':>6}")
    for r in rows[:12]:
        print(f"{r['team']:<5}{r['gp']:>3}{r['pts']:>4}{r['exp_pts']:>6.1f}{r['division']*100:>7.1f}{r['playoffs']*100:>9.1f}{r['r2']*100:>6.1f}{r['r3']*100:>6.1f}{r['final']*100:>7.1f}{r['cup']*100:>6.1f}")
    print(f"... done in {time.time() - t0:.0f}s; sums: cup {sum(r['cup'] for r in rows):.3f}, playoffs {sum(r['playoffs'] for r in rows):.2f} (16), divisions {sum(r['division'] for r in rows):.2f} (4)")
    if not dry_run:
        publish_rows(rows, season, n_sims, sigma, now)
    return rows


def publish_rows(rows: list[dict], season: int, n_sims: int, sigma: float, now: pd.Timestamp) -> None:
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    payload = [{"season": season, "team": r["team"], "stats": {k: v for k, v in r.items() if k != "team"}, "updated_at": now.isoformat()} for r in rows]
    try:
        client.table("nhl_futures").upsert(payload, on_conflict="season,team").execute()
        print(f"published {len(payload)} teams to nhl_futures")
    except Exception as e:  # noqa: BLE001
        if "PGRST205" in str(e) or "schema cache" in str(e):
            print("(futures not published: run the nhl_futures block in supabase/schema.sql)")
        else:
            raise


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sims", type=int, default=10000)
    ap.add_argument("--sigma", type=float, default=SIGMA)
    a = ap.parse_args()
    run(dry_run=a.dry_run, n_sims=a.sims, sigma=a.sigma)


if __name__ == "__main__":
    main()
