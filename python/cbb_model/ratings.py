"""
Team ratings for Division I men's basketball - the same family as KenPom / Barttorvik, built from our own box-score table.

Each team gets an adjusted OFFENSE and DEFENSE (points per 100 possessions, against an average team, on a neutral court)
and an adjusted TEMPO (possessions per 40 minutes). They come from one ridge regression per rating date over that season's
games:

    points per 100 possessions of team T vs opponent O
        = mu + hca * (+1 home / -1 away / 0 neutral) + off[T] + def[O]          (def is "allowed above average": lower = better)
    possessions per 40 minutes of a game between A and B = mu_t + tempo[A] + tempo[B]

fitted with recency weights (older games count less) and shrunk toward each team's PRIOR rating - last season's final
rating pulled toward average (a preseason model replaces this prior later). The ridge penalty is a number of "games of
prior": with lambda = 8 a team's own results outweigh its prior after about eight games.

A game is then projected as
    possessions = mu_t + tempo[H] + tempo[A]
    home points = (mu + hca + off[H] + def[A]) * possessions / 100        (hca = 0 on a neutral floor)
    away points = (mu - hca + off[A] + def[H]) * possessions / 100
giving a spread (home - away) and a total.

Usage:
    python -m cbb_model.ratings backtest --first 2022 --last 2025
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .parse import CLOSING_ODDS_OUT, TEAM_GAMES_OUT


@dataclass
class Config:
    half_life_days: float = 120.0  # older games in the season count for less
    lam_eff: float = 0.5  # ridge strength on offence/defence, in "games of prior" (tuned on 2025 against closing lines)
    lam_tempo: float = 3.0
    prior_keep: float = 0.70  # share of last season's final rating carried in as the prior
    cap: float = 25.0  # per-100-possession efficiency is clipped to mu +/- cap (garbage-time guard)
    hca_prior: float = 2.5  # home court, per 100 possessions per side (~3.5 points of margin); the data may move it a little
    lam_hca: float = 1500.0
    min_games: int = 1


@dataclass
class Ratings:
    off: dict
    de: dict
    tempo: dict
    mu: float
    hca: float
    mu_t: float
    n_games: dict


def _design(team_ids: np.ndarray, opp_ids: np.ndarray, index: dict, n: int, home_sign: np.ndarray):
    rows = len(team_ids)
    X = np.zeros((rows, 2 * n + 1))
    t = np.fromiter((index[i] for i in team_ids), dtype=int, count=rows)
    o = np.fromiter((index[i] for i in opp_ids), dtype=int, count=rows)
    X[np.arange(rows), t] = 1.0  # off[T]
    X[np.arange(rows), n + o] = 1.0  # def[O]
    X[:, 2 * n] = home_sign
    return X


def fit(tg: pd.DataFrame, as_of: pd.Timestamp, cfg: Config, prior: Ratings | None = None, season: int | None = None) -> Ratings | None:
    """Ratings from the games of `season` strictly before `as_of`."""
    g = tg[(tg["start_utc"] < as_of)]
    if season is not None:
        g = g[g["season"] == season]
    if len(g) < 50:
        return None
    g = g.copy()
    ids = np.unique(np.concatenate([g["team_id"].to_numpy(), g["opp_id"].to_numpy()]))
    index = {int(t): i for i, t in enumerate(ids)}
    n = len(ids)

    age = (as_of - g["start_utc"]).dt.total_seconds().to_numpy() / 86400.0
    w = 0.5 ** (age / cfg.half_life_days)
    w = w / w.mean()  # average weight 1, so lambda always means "games of prior" however much the season has decayed
    eff = (g["pts"].to_numpy() / g["poss"].to_numpy() * 100.0)
    mu = float(np.average(eff, weights=w))
    eff = np.clip(eff, mu - cfg.cap, mu + cfg.cap)
    home_sign = np.where(g["neutral"].to_numpy() == 1, 0.0, np.where(g["is_home"].to_numpy() == 1, 1.0, -1.0))
    X = _design(g["team_id"].to_numpy(), g["opp_id"].to_numpy(), index, n, home_sign)

    # prior offsets: last season's (shrunk) ratings
    p_off = np.zeros(n)
    p_def = np.zeros(n)
    if prior is not None:
        for t, i in index.items():
            p_off[i] = prior.off.get(t, 0.0) * cfg.prior_keep
            p_def[i] = prior.de.get(t, 0.0) * cfg.prior_keep
    base = np.concatenate([p_off, p_def, [cfg.hca_prior]])
    y = eff - mu - X @ base

    # ridge on the deviations from the prior (the home-court term is unpenalised)
    W = w[:, None]
    A = X.T @ (X * W)
    reg = np.full(2 * n + 1, cfg.lam_eff)
    reg[2 * n] = cfg.lam_hca
    A[np.diag_indices_from(A)] += reg
    b = X.T @ (y * w)
    sol = np.linalg.solve(A, b)
    off = p_off + sol[:n]
    de = p_def + sol[n : 2 * n]
    hca = float(cfg.hca_prior + sol[2 * n])
    # centre so the average team is 0
    off -= np.average(off)
    de -= np.average(de)

    # tempo: one row per game (the two teams share possessions)
    gg = g[g["is_home"] == 1]
    ti = np.fromiter((index[i] for i in gg["team_id"].to_numpy()), dtype=int, count=len(gg))
    oi = np.fromiter((index[i] for i in gg["opp_id"].to_numpy()), dtype=int, count=len(gg))
    Xt = np.zeros((len(gg), n))
    Xt[np.arange(len(gg)), ti] += 1.0
    Xt[np.arange(len(gg)), oi] += 1.0
    wt = 0.5 ** (((as_of - gg["start_utc"]).dt.total_seconds().to_numpy() / 86400.0) / cfg.half_life_days)
    wt = wt / wt.mean()
    yt = gg["tempo"].to_numpy()
    mu_t = float(np.average(yt, weights=wt))
    p_t = np.zeros(n)
    if prior is not None:
        for t, i in index.items():
            p_t[i] = prior.tempo.get(t, 0.0) * cfg.prior_keep
    yt2 = yt - mu_t - Xt @ p_t
    At = Xt.T @ (Xt * wt[:, None]) + np.eye(n) * cfg.lam_tempo
    st = np.linalg.solve(At, Xt.T @ (yt2 * wt))
    tempo = p_t + st
    tempo -= np.average(tempo)

    counts = g.groupby("team_id").size()
    return Ratings(
        off={int(t): float(off[i]) for t, i in index.items()},
        de={int(t): float(de[i]) for t, i in index.items()},
        tempo={int(t): float(tempo[i]) for t, i in index.items()},
        mu=mu,
        hca=hca,
        mu_t=mu_t,
        n_games={int(t): int(counts.get(t, 0)) for t in index},
    )


def project(r: Ratings, home_id: int, away_id: int, neutral: bool = False) -> dict | None:
    if home_id not in r.off or away_id not in r.off:
        return None
    poss = r.mu_t + r.tempo[home_id] + r.tempo[away_id]
    hca = 0.0 if neutral else r.hca
    ph = (r.mu + hca + r.off[home_id] + r.de[away_id]) * poss / 100.0
    pa = (r.mu - hca + r.off[away_id] + r.de[home_id]) * poss / 100.0
    return {"home_pts": ph, "away_pts": pa, "spread": ph - pa, "total": ph + pa, "poss": poss}


# ------------------------------------------------------------------ walk-forward backtest

def load() -> pd.DataFrame:
    tg = pd.read_csv(TEAM_GAMES_OUT)
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    return tg.sort_values(["start_utc", "event_id"]).reset_index(drop=True)


def walk_forward(tg: pd.DataFrame, cfg: Config, seasons: list[int], block_days: int = 7) -> pd.DataFrame:
    """Projections for every game of each season, each made with only the games before its week."""
    out = []
    prior: Ratings | None = None
    all_seasons = sorted(tg["season"].unique())
    for s in all_seasons:
        if s > max(seasons):
            break
        games = tg[(tg["season"] == s) & (tg["is_home"] == 1)]
        if games.empty:
            continue
        if s in seasons or s == min(seasons) - 1:
            start = games["start_utc"].min().normalize()
            end = games["start_utc"].max()
            block = start
            while block <= end:
                nxt = block + pd.Timedelta(days=block_days)
                batch = games[(games["start_utc"] >= block) & (games["start_utc"] < nxt)]
                if len(batch) and s in seasons:
                    fit_r = fit(tg, block, cfg, prior=prior, season=s)
                    if fit_r is None and prior is not None:
                        fit_r = prior  # very first days: the prior alone
                    if fit_r is not None:
                        for r in batch.itertuples():
                            p = project(fit_r, int(r.team_id), int(r.opp_id), neutral=bool(r.neutral))
                            if p:
                                out.append({"event_id": r.event_id, "season": s, "start_utc": r.start_utc, "home_id": r.team_id, "away_id": r.opp_id,
                                            "actual_margin": r.pts - r.opp_pts, "actual_total": r.pts + r.opp_pts, "n_h": fit_r.n_games.get(int(r.team_id), 0), "n_a": fit_r.n_games.get(int(r.opp_id), 0), **p})
                block = nxt
        # this season's final ratings become next season's prior
        prior = fit(tg, games["start_utc"].max() + pd.Timedelta(days=1), cfg, prior=prior, season=s) or prior
    return pd.DataFrame(out)


def report(pred: pd.DataFrame, odds: pd.DataFrame, label: str) -> None:
    m = pred.merge(odds[["event_id", "spread_home_close", "total_close"]], on="event_id", how="left")
    # market spread is the HOME line (negative = home favoured): the market's home margin is -line
    m["mkt_margin"] = -m["spread_home_close"]
    print(f"\n== {label}: {len(m):,} games, {m['mkt_margin'].notna().sum():,} with a closing line ==")
    mae = lambda a, b: float(np.mean(np.abs(a - b)))  # noqa: E731
    print(f"margin MAE: model {mae(m['spread'], m['actual_margin']):.2f}", end="")
    if m["mkt_margin"].notna().any():
        mm = m[m["mkt_margin"].notna()]
        print(f" | on lined games: model {mae(mm['spread'], mm['actual_margin']):.2f} vs market {mae(mm['mkt_margin'], mm['actual_margin']):.2f}")
    else:
        print()
    print(f"total  MAE: model {mae(m['total'], m['actual_total']):.2f}", end="")
    if m["total_close"].notna().any():
        mt = m[m["total_close"].notna()]
        print(f" | on lined games: model {mae(mt['total'], mt['actual_total']):.2f} vs market {mae(mt['total_close'], mt['actual_total']):.2f}")
    else:
        print()
    # does the model's disagreement with the market predict anything? (needs lines)
    mm = m[m["mkt_margin"].notna()].copy()
    if len(mm) > 200:
        mm["gap"] = mm["spread"] - mm["mkt_margin"]
        for lo, hi in ((0, 1), (1, 2), (2, 3), (3, 5), (5, 99)):
            s = mm[(mm["gap"].abs() >= lo) & (mm["gap"].abs() < hi)]
            if len(s) < 50:
                continue
            side_home = s["gap"] > 0  # model likes home more than the market
            cover = np.where(side_home, s["actual_margin"] > s["mkt_margin"], s["actual_margin"] < s["mkt_margin"])
            push = s["actual_margin"] == s["mkt_margin"]
            n = int((~push).sum())
            print(f"  spread gap {lo}-{hi}: {len(s):,} games, model side covers {cover[~push.to_numpy()].mean() * 100:.1f}% of {n:,}")
    mt = m[m["total_close"].notna()].copy()
    if len(mt) > 200:
        mt["gap"] = mt["total"] - mt["total_close"]
        for lo, hi in ((0, 2), (2, 4), (4, 7), (7, 99)):
            s = mt[(mt["gap"].abs() >= lo) & (mt["gap"].abs() < hi)]
            if len(s) < 50:
                continue
            over = s["gap"] > 0
            res = np.sign(s["actual_total"] - s["total_close"])
            keep = res != 0
            win = np.where(over, res > 0, res < 0)[keep.to_numpy()]
            print(f"  total gap {lo}-{hi}: {len(s):,} games, model side hits {win.mean() * 100:.1f}% of {int(keep.sum()):,}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["backtest"])
    ap.add_argument("--first", type=int, default=2022)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--half-life", type=float, default=Config.half_life_days)
    ap.add_argument("--lam", type=float, default=Config.lam_eff)
    ap.add_argument("--keep", type=float, default=Config.prior_keep)
    a = ap.parse_args()
    cfg = Config(half_life_days=a.half_life, lam_eff=a.lam, prior_keep=a.keep)
    tg = load()
    odds = pd.read_csv(CLOSING_ODDS_OUT)
    seasons = list(range(a.first, a.last + 1))
    pred = walk_forward(tg, cfg, seasons)
    for s in seasons:
        report(pred[pred["season"] == s], odds, f"season {s}")
    report(pred, odds, f"all {a.first}-{a.last}")
    # early vs late season (the prior matters most early)
    early = pred[(pred["n_h"] < 8) | (pred["n_a"] < 8)]
    report(early, odds, "early season (a team has played < 8 games)")


if __name__ == "__main__":
    main()
