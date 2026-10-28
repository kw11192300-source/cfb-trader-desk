"""
Player-up + team-up in ONE model: a team's offence (and defence) is the sum of its players' ratings weighted by the minutes they are
expected to play tonight, PLUS a team-level adjustment for everything a roster list does not capture (coach, system, chemistry):

    points per 100 possessions of team T vs O =  mu + hca*h + sum_{p in T} s_p * off_p + tau_off[T]
                                                     + sum_{q in O} s_q * def_q + tau_def[O]

s_p is the player's share of the team's minutes (sums to 1). Player ratings start from last season's posterior (pulled toward 0,
progression is mean-reverting) and are updated by this season's games; the team adjustments start at 0. Both sets are shrunk by a
ridge, so ONE knob decides the mix:  a strong penalty on the team terms = a pure player-up model (who is on the floor tonight is
everything), a strong penalty on the player terms = the existing team-up model. The data picks the sweet spot.

Predicting a game needs tonight's minutes shares. Three versions are tested:
  all    - each player's trailing share, ignoring who is hurt (what you know with no injury news)
  last   - only players who played in the team's previous game
  known  - only players who actually played in THIS game (what an injury report gives you near tip; an upper bound)

    python -m cbb_model.playerup evaluate
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.sparse.linalg import LinearOperator, cg

from .inseason import CONFIG
from .parse import PLAYER_GAMES_OUT, TEAM_GAMES_OUT
from .ratings import load, walk_forward

K_TRAIL = 10  # games in a player's trailing minutes share
KEEP = 0.6  # share of last season's player rating carried into the next season (progression is mean-reverting)
HALF_LIFE = 120.0
CAP = 25.0
HCA_PRIOR = 2.5


def shares_table() -> pd.DataFrame:
    pg = pd.read_csv(PLAYER_GAMES_OUT, usecols=["event_id", "season", "start_utc", "team_id", "player_id", "min"], low_memory=False)
    pg = pg[pg["min"] > 0].copy()
    pg["player_id"] = pg["player_id"].astype("int64")
    pg["s"] = pg["min"] / pg.groupby(["event_id", "team_id"])["min"].transform("sum")
    pg["start_utc"] = pd.to_datetime(pg["start_utc"], utc=True)
    return pg


def trailing_shares(pg: pd.DataFrame, tg: pd.DataFrame) -> dict[tuple[int, int], dict[int, dict]]:
    """For every (event, team): each rostered player's trailing share (last K team games, missing = 0) and whether he played last game,
    computed from games BEFORE the one in question."""
    by_game = {k: g for k, g in pg.groupby(["event_id", "team_id"])}
    out: dict[tuple[int, int], dict[int, dict]] = {}
    hist: dict[int, list[dict[int, float]]] = {}  # team -> list of (player->share) of its recent games, oldest first
    games = tg.sort_values(["start_utc", "event_id"])
    for r in games.itertuples():
        key = (int(r.event_id), int(r.team_id))
        past = hist.get(int(r.team_id), [])[-K_TRAIL:]
        trail: dict[int, float] = {}
        for g in past:
            for p, v in g.items():
                trail[p] = trail.get(p, 0.0) + v / K_TRAIL
        last = set(past[-1]) if past else set()
        out[key] = {"trail": trail, "last": last}
        cur = by_game.get(key)
        if cur is not None:
            hist.setdefault(int(r.team_id), []).append(dict(zip(cur["player_id"].astype(int), cur["s"])))
    return out


def vector(trail: dict, allowed: set | None) -> dict[int, float]:
    d = {p: v for p, v in trail.items() if allowed is None or p in allowed}
    tot = sum(d.values())
    return {p: v / tot for p, v in d.items()} if tot > 0 else {}


class SeasonFit:
    def __init__(self, o: dict, d: dict, to: dict, td: dict, mu: float, hca: float, n_games: dict):
        self.o, self.d, self.to, self.td, self.mu, self.hca, self.n_games = o, d, to, td, mu, hca, n_games


class SeasonModel:
    """One season's observations as a fixed sparse design (rows in time order), so each weekly refit only slices the first n rows and
    re-solves - the design is never rebuilt. The ridge is solved by conjugate gradient with a diagonal preconditioner (the direct
    solve took ~90 s per fit with ~10,000 players; this takes a couple of seconds)."""

    def __init__(self, obs: pd.DataFrame, shares: dict[tuple[int, int], dict[int, float]]):
        d = obs.sort_values(["t", "event_id"]).reset_index(drop=True)
        self.t = d["t"].dt.tz_convert("UTC").dt.tz_localize(None).to_numpy()
        self.y = d["y"].to_numpy(float)
        players: dict[int, int] = {}
        teams: dict[int, int] = {}
        for r in d.itertuples():
            teams.setdefault(int(r.team_id), len(teams))
            teams.setdefault(int(r.opp_id), len(teams))
            for key in ((int(r.event_id), int(r.team_id)), (int(r.event_id), int(r.opp_id))):
                for p in shares.get(key, {}):
                    players.setdefault(p, len(players))
        self.players, self.teams = players, teams
        P, T = len(players), len(teams)
        self.P, self.T = P, T
        rows, cols, vals = [], [], []
        for i, r in enumerate(d.itertuples()):
            rows += [i, i]
            cols += [0, 1]
            vals += [1.0, float(r.h)]
            for p, sh in shares.get((int(r.event_id), int(r.team_id)), {}).items():
                rows.append(i)
                cols.append(2 + players[p])
                vals.append(sh)
            for p, sh in shares.get((int(r.event_id), int(r.opp_id)), {}).items():
                rows.append(i)
                cols.append(2 + P + players[p])
                vals.append(sh)
            rows += [i, i]
            cols += [2 + 2 * P + teams[int(r.team_id)], 2 + 2 * P + T + teams[int(r.opp_id)]]
            vals += [1.0, 1.0]
        self.X = sp.csr_matrix((vals, (rows, cols)), shape=(len(d), 2 + 2 * P + 2 * T))
        self.Xt = self.X.T.tocsr()
        self.X2t = self.Xt.multiply(self.Xt).tocsr()
        self.team_of_row = d["team_id"].to_numpy()
        self.mu0 = float(d["y"].mean())

    def fit(self, as_of: pd.Timestamp, prior_o: dict, prior_d: dict, lam_p: float, lam_t: float, x0: np.ndarray | None = None) -> tuple[SeasonFit | None, np.ndarray | None]:
        cutoff = np.datetime64(as_of.tz_convert("UTC").tz_localize(None))
        n = int(np.searchsorted(self.t, cutoff))
        if n < 40:
            return None, None
        P, T = self.P, self.T
        nvar = 2 + 2 * P + 2 * T
        X, Xt = self.X[:n], self.Xt[:, :n]
        age = (cutoff - self.t[:n]).astype("timedelta64[s]").astype(float) / 86400.0
        w = 0.5 ** (age / HALF_LIFE)
        b0 = np.zeros(nvar)
        b0[0], b0[1] = self.mu0, HCA_PRIOR
        for p, j in self.players.items():
            b0[2 + j] = prior_o.get(p, 0.0)
            b0[2 + P + j] = prior_d.get(p, 0.0)
        lam = np.full(nvar, lam_t)
        lam[0], lam[1] = 1e-6, 1500.0
        lam[2 : 2 + 2 * P] = lam_p
        rhs = Xt @ (w * (self.y[:n] - X @ b0))
        diag = np.asarray(self.X2t[:, :n] @ w).ravel() + lam  # diagonal of X'WX + lambda
        A = LinearOperator((nvar, nvar), matvec=lambda v: Xt @ (w * (X @ v)) + lam * v, dtype=float)
        M = LinearOperator((nvar, nvar), matvec=lambda v: v / diag, dtype=float)
        delta, info = cg(A, rhs, x0=None if x0 is None else x0 - b0, M=M, rtol=1e-6, maxiter=800)
        beta = b0 + delta
        inv_p = {j: p for p, j in self.players.items()}
        inv_t = {j: tm for tm, j in self.teams.items()}
        ng = pd.Series(self.team_of_row[:n]).value_counts().to_dict()
        return SeasonFit(
            {inv_p[j]: beta[2 + j] for j in range(P)}, {inv_p[j]: beta[2 + P + j] for j in range(P)},
            {inv_t[j]: beta[2 + 2 * P + j] for j in range(T)}, {inv_t[j]: beta[2 + 2 * P + T + j] for j in range(T)},
            float(beta[0]), float(beta[1]), {int(k): int(v) for k, v in ng.items()},
        ), beta


def side_rating(fit: SeasonFit, vec: dict[int, float], team: int, kind: str) -> float:
    ratings = fit.o if kind == "o" else fit.d
    tau = (fit.to if kind == "o" else fit.td).get(team, 0.0)
    return sum(s * ratings.get(p, 0.0) for p, s in vec.items()) + tau


def run(lam_p: float, lam_t_list: list[float], seasons: list[int], block_days: int = 7) -> pd.DataFrame:
    tg = load()
    pg = shares_table()
    sh_all = {k: dict(zip(g["player_id"].astype(int), g["s"])) for k, g in pg.groupby(["event_id", "team_id"])}
    trail = trailing_shares(pg, tg)
    out = []
    prior_o: dict[int, float] = {}
    prior_d: dict[int, float] = {}
    all_seasons = sorted(tg["season"].unique())
    t0 = time.time()
    for s in all_seasons:
        if s > max(seasons):
            break
        g = tg[(tg["season"] == s)].copy()
        if g.empty:
            continue
        g["y"] = g["pts"] / g["poss"] * 100.0
        mu0 = float(g["y"].mean())
        g["y"] = g["y"].clip(mu0 - CAP, mu0 + CAP)
        g["h"] = np.where(g["neutral"] == 1, 0.0, np.where(g["is_home"] == 1, 1.0, -1.0))
        g["t"] = g["start_utc"]
        model = SeasonModel(g, sh_all)
        home = g[g["is_home"] == 1]
        start, end = home["start_utc"].min().normalize(), home["start_utc"].max()
        if s in seasons:
            warm = {lt: None for lt in lam_t_list}
            block = start
            while block <= end:
                nxt = block + pd.Timedelta(days=block_days)
                batch = home[(home["start_utc"] >= block) & (home["start_utc"] < nxt)]
                if len(batch):
                    fits = {}
                    for lt in lam_t_list:
                        f, beta = model.fit(block, prior_o, prior_d, lam_p, lt, warm[lt])
                        fits[lt] = f
                        warm[lt] = beta
                    for r in batch.itertuples():
                        row = {"event_id": r.event_id, "season": s, "start_utc": r.start_utc, "actual_margin": r.pts - r.opp_pts, "actual_total": r.pts + r.opp_pts, "poss_actual": r.poss}
                        th, ta = trail[(int(r.event_id), int(r.team_id))], trail[(int(r.event_id), int(r.opp_id))]
                        played_h, played_a = set(sh_all.get((int(r.event_id), int(r.team_id)), {})), set(sh_all.get((int(r.event_id), int(r.opp_id)), {}))
                        for lt, f in fits.items():
                            if f is None:
                                continue
                            for var, (ah, aa) in {"all": (None, None), "last": (th["last"], ta["last"]), "known": (played_h, played_a)}.items():
                                vh, va = vector(th["trail"], ah), vector(ta["trail"], aa)
                                hca = 0.0 if r.neutral == 1 else f.hca
                                oh, dh = side_rating(f, vh, int(r.team_id), "o"), side_rating(f, vh, int(r.team_id), "d")
                                oa, da = side_rating(f, va, int(r.opp_id), "o"), side_rating(f, va, int(r.opp_id), "d")
                                row[f"ppp_diff_{var}_{lt:g}"] = (f.mu + hca + oh + da) - (f.mu - hca + oa + dh)
                                row[f"ppp_sum_{var}_{lt:g}"] = (f.mu + hca + oh + da) + (f.mu - hca + oa + dh)
                        out.append(row)
                block = nxt
            print(f"  season {s} done ({time.time() - t0:.0f}s)", flush=True)
        # the season's final posterior becomes next season's prior (mean-reverting)
        fin, _ = model.fit(g["start_utc"].max() + pd.Timedelta(days=1), prior_o, prior_d, lam_p, lam_t_list[0])
        if fin is not None:
            prior_o = {p: KEEP * v for p, v in fin.o.items()}
            prior_d = {p: KEEP * v for p, v in fin.d.items()}
    return pd.DataFrame(out)


def evaluate(seasons: list[int], lam_p: float, lam_ts: list[float]) -> None:
    t0 = time.time()
    tg = load()
    odds = pd.read_csv(TEAM_GAMES_OUT.parent / "closing_odds.csv")[["event_id", "spread_home_close", "total_close"]]
    base = walk_forward(tg, CONFIG, seasons)  # the team-up baseline the site runs today (last season's rating as the prior)
    print(f"baseline built in {time.time() - t0:.0f}s: {len(base):,} games", flush=True)
    pu = run(lam_p, lam_ts, seasons)
    print(f"player-up fits in {time.time() - t0:.0f}s: {len(pu):,} games", flush=True)
    m = base.merge(pu.drop(columns=["actual_margin", "actual_total", "season", "start_utc"]), on="event_id", how="inner").merge(odds, on="event_id", how="left")
    m["mkt"] = -m["spread_home_close"]
    m.to_pickle(TEAM_GAMES_OUT.parent / "playerup_eval.pkl")
    mae = lambda a, b: float(np.mean(np.abs(a - b)))  # noqa: E731
    lined = m[m["mkt"].notna()]
    print(f"\n{len(m):,} games ({len(lined):,} lined) seasons {seasons} | lam_player {lam_p}")
    print(f"baseline team-up: MAE {mae(m['spread'], m['actual_margin']):.3f} (lined {mae(lined['spread'], lined['actual_margin']):.3f}) | market {mae(lined['mkt'], lined['actual_margin']):.3f}")
    for lt in lam_ts:
        for var in ("all", "last", "known"):
            pm = m[f"ppp_diff_{var}_{lt:g}"] * m["poss"] / 100.0
            pl = lined[f"ppp_diff_{var}_{lt:g}"] * lined["poss"] / 100.0
            print(f"  lam_team {lt:>7g} {var:<6}: MAE {mae(pm, m['actual_margin']):.3f} (lined {mae(pl, lined['actual_margin']):.3f})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate"])
    ap.add_argument("--seasons", default="2023,2024,2025")
    ap.add_argument("--lam-player", type=float, default=2.0)
    ap.add_argument("--lam-team", default="3,10,50,1000")
    a = ap.parse_args()
    evaluate([int(x) for x in a.seasons.split(",")], a.lam_player, [float(x) for x in a.lam_team.split(",")])


if __name__ == "__main__":
    main()
