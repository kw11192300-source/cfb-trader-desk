"""
The goalie test: does knowing who is in net close the gap to the market?

baseline.py rates teams as a unit, so a team's goals-against quietly includes
whoever happened to tend goal in the games it learned from. The closing line
knows the confirmed starter; the baseline doesn't. This module separates the
two things hockey separates:

  stage 1  team ratings fit on xG ALONE (chances created / allowed - far less
           noisy than goals, and independent of who was in net) -> expected
           goals for each side against an AVERAGE goalie
  stage 2  the opposing goalie's pre-game rating bends that expectation:
           goals = chances * exp(beta * (goalie rating - average))

Goalie rating = goals saved above expected per 100 unblocked attempts faced
(our xG minus goals allowed), accumulated over that goalie's PRIOR games only
(exponentially decayed), shrunk toward 0 by `prior_attempts` of average-goalie
evidence - a goalie who has faced 300 attempts shouldn't be rated on them.
beta is fit per prediction block on the training rows' REALIZED xG -> goals
(so it measures conversion given chances, not team quality) and comes out
negative: a better goalie means fewer goals.

ORACLE caveat, deliberate: here the goalie is whoever actually started
(first to face a shot). In real use the starter is only confirmed on game
day - so this is the best case for what goalie knowledge can add, the same
knowledge the closing line has. If even the oracle can't close the gap, a
goalie feed isn't the answer; if it does, getting confirmed starters
becomes the most valuable data problem.

Usage:
    python -m nhl_model.goalie_model
"""
from __future__ import annotations

import itertools
import warnings
from collections import defaultdict

import numpy as np
import pandas as pd

from .backtest import BLOCK_DAYS, TEST_SEASONS, TUNE_SEASONS, load, logloss
from .baseline import Config, fit_ratings, summarize
from .ingest import DATA_DIR
from .odds import ODDS_OUT, market_consensus
from .parse import GAMES_OUT
from .xg import SHOTS_XG_OUT

warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message="Unknown solver options")

GOALIE_HALF_LIFE_DAYS = 540.0


def goalie_game_performance() -> pd.DataFrame:
    s = pd.read_csv(SHOTS_XG_OUT, usecols=["game_id", "goalie_id", "xg", "is_goal"], low_memory=False)
    s = s[s["xg"].notna() & s["goalie_id"].notna()]
    return s.groupby(["game_id", "goalie_id"]).agg(att=("xg", "size"), xg=("xg", "sum"), goals=("is_goal", "sum")).reset_index()


def pregame_goalie_ratings(prior_attempts: float, half_life: float = GOALIE_HALF_LIFE_DAYS) -> pd.DataFrame:
    """One row per game: the pre-game rating (goals saved above expected per
    100 attempts, shrunk) of each side's starting goalie, using only games
    played BEFORE it."""
    games = pd.read_csv(GAMES_OUT, usecols=["game_id", "start_utc", "home_goalie", "away_goalie"])
    games["t"] = pd.to_datetime(games["start_utc"], utc=True)
    games = games.sort_values(["t", "game_id"])
    perf = goalie_game_performance()
    by_game = {gid: g for gid, g in perf.groupby("game_id")}
    state: dict[float, list[float]] = defaultdict(lambda: [None, 0.0, 0.0])  # goalie -> [last_time, decayed diff, decayed attempts]

    def rating(gid: float | None, now: pd.Timestamp) -> float:
        if gid is None or pd.isna(gid) or state[gid][0] is None:
            return 0.0
        last, diff, att = state[gid]
        f = 0.5 ** ((now - last).total_seconds() / 86400.0 / half_life)
        return 100.0 * (diff * f) / (att * f + prior_attempts)

    rows = []
    for r in games.itertuples():
        rows.append((r.game_id, rating(r.home_goalie, r.t), rating(r.away_goalie, r.t)))
        g = by_game.get(r.game_id)
        if g is None:
            continue
        for gid, att, xg, goals in zip(g["goalie_id"], g["att"], g["xg"], g["goals"]):
            last, diff, a = state[gid]
            if last is not None:
                f = 0.5 ** ((r.t - last).total_seconds() / 86400.0 / half_life)
                diff, a = diff * f, a * f
            state[gid] = [r.t, diff + (xg - goals), a + att]
    return pd.DataFrame(rows, columns=["game_id", "home_goalie_rating", "away_goalie_rating"])


def fit_poisson_offset(y: np.ndarray, offset: np.ndarray, x: np.ndarray, w: np.ndarray, iters: int = 25) -> tuple[float, float]:
    """Poisson regression y ~ exp(offset + a + b*x), weighted, via Newton - two parameters."""
    a, b = 0.0, 0.0
    for _ in range(iters):
        eta = offset + a + b * x
        mu = np.exp(eta)
        g = np.array([np.sum(w * (y - mu)), np.sum(w * (y - mu) * x)])
        h = np.array([[np.sum(w * mu), np.sum(w * mu * x)], [np.sum(w * mu * x), np.sum(w * mu * x * x)]]) + 1e-9 * np.eye(2)
        step = np.linalg.solve(h, g)
        a, b = a + step[0], b + step[1]
        if np.abs(step).max() < 1e-8:
            break
    return a, b


def walk_forward(tg: pd.DataFrame, gr: pd.DataFrame, cfg: Config, seasons: tuple[int, ...], use_goalie: bool) -> pd.DataFrame:
    tg = tg.merge(gr, on="game_id", how="left")
    # rating of the goalie each ROW's attacker FACES (opponent's goalie)
    tg["opp_goalie_rating"] = np.where(tg["is_home"] == 1, tg["away_goalie_rating"], tg["home_goalie_rating"])
    tg["opp_goalie_rating"] = tg["opp_goalie_rating"].fillna(0.0)
    home = tg[(tg["is_home"] == 1) & tg["season"].isin(seasons)]
    preds = []
    block_start = home["start_utc"].min().normalize()
    t1 = home["start_utc"].max()
    while block_start <= t1:
        block_end = block_start + pd.Timedelta(days=BLOCK_DAYS)
        block = home[(home["start_utc"] >= block_start) & (home["start_utc"] < block_end)]
        fit = fit_ratings(tg, block_start, cfg) if len(block) else None
        if fit is not None:
            beta, gbar = 0.0, 0.0
            if use_goalie:
                train = tg[(tg["start_utc"] < block_start) & (tg["start_utc"] >= block_start - pd.Timedelta(days=cfg.lookback_days))]
                train = train[train["xg_reg"] > 0]
                age = (block_start - train["start_utc"]).dt.total_seconds() / 86400.0
                w = np.exp(-np.log(2) * age / cfg.half_life_days).to_numpy()
                x = train["opp_goalie_rating"].to_numpy()
                gbar = float(np.average(x, weights=w))
                _, beta = fit_poisson_offset(train["goals_for_reg_official"].to_numpy(float), np.log(train["xg_reg"].to_numpy()), x - gbar, w)
            for r in block.itertuples():
                lh, la = fit.lambdas(int(r.team_id), int(r.opp_id))
                if use_goalie:
                    lh *= np.exp(beta * (r.away_goalie_rating - gbar))  # home shots face the AWAY goalie
                    la *= np.exp(beta * (r.home_goalie_rating - gbar))
                s = summarize(lh, la, fit.ot_home_share)
                s.update(game_id=r.game_id, season=r.season, start_utc=r.start_utc, home_win=int(r.final_for > r.final_against),
                         final_total=r.final_for + r.final_against, reg_margin=r.goals_for_reg_official - r.goals_against_reg_official, beta=beta)
                preds.append(s)
        block_start = block_end
    return pd.DataFrame(preds)


def main() -> None:
    tg = load()
    base_cfg = Config(half_life_days=300.0, prior_games=10.0, goal_weight=0.0)  # xG-only team ratings
    market = market_consensus(pd.read_csv(ODDS_OUT))

    print("tuning goalie shrinkage (prior attempts) on", TUNE_SEASONS, "...")
    best = None
    for k in (1000.0, 2500.0, 5000.0):
        gr = pregame_goalie_ratings(k)
        p = walk_forward(tg, gr, base_cfg, TUNE_SEASONS, True)
        ll = logloss(p["home_win"].to_numpy(), p["p_home"].to_numpy())
        print(f"  prior_attempts={k:6.0f} -> log loss {ll:.4f}  (beta {p['beta'].mean():+.4f})")
        best = min(best, (ll, k)) if best else (ll, k)
    k = best[1]
    print(f"chosen prior_attempts = {k:.0f}\n")

    gr = pregame_goalie_ratings(k)
    prior = pd.read_csv(DATA_DIR / "backtest_predictions.csv.gz")  # baseline.py team model, goals+xG blend
    variants = {
        "V0 baseline (blend, no goalie)": prior,
        "V1 xG-only ratings, no goalie": walk_forward(tg, gr, base_cfg, TEST_SEASONS, False),
        "V2 xG ratings + ORACLE goalie": walk_forward(tg, gr, base_cfg, TEST_SEASONS, True),
    }
    print(f"held-out {TEST_SEASONS[0]}-{TEST_SEASONS[-1]}; average goalie beta = {variants['V2 xG ratings + ORACLE goalie']['beta'].mean():+.4f} per rating point (negative = better goalie, fewer goals)\n")

    rows = []
    for name, p in variants.items():
        d = p.merge(market[["game_id", "mkt_p_home", "era"]], on="game_id", how="inner")
        for scope, x in (("all with a line", d), ("true closes only", d[d["era"] == "close"])):
            y = x["home_win"].to_numpy()
            rows.append({
                "variant": name, "scope": scope, "n": len(x),
                "model": logloss(y, x["p_home"].to_numpy()), "market": logloss(y, x["mkt_p_home"].to_numpy()),
                "blend": logloss(y, 0.5 * x["p_home"].to_numpy() + 0.5 * x["mkt_p_home"].to_numpy()),
            })
    t = pd.DataFrame(rows)
    t["gap_vs_market"] = t["model"] - t["market"]
    print(t.round(4).to_string(index=False))

    v2 = variants["V2 xG ratings + ORACLE goalie"]
    print("\nV2 totals / puck line calibration:",
          f"avg final total predicted {v2['exp_total_final'].mean():.3f} vs actual {v2['final_total'].mean():.3f};",
          f"P(over 5.5) {v2['p_over_5.5'].mean():.3f} vs {(v2['final_total'] > 5.5).mean():.3f};",
          f"home -1.5 {v2['p_home_cover_m15'].mean():.3f} vs {(v2['reg_margin'] >= 2).mean():.3f}")
    v2.to_csv(DATA_DIR / "goalie_oracle_predictions.csv.gz", index=False)


if __name__ == "__main__":
    main()
