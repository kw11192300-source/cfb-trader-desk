"""
What is an NBA player worth to the spread and the total - and does the market price it?

For every rotation player (14+ minutes a game over 15+ games for a team in a season) we find the games his team played without
him (he was on the roster but did not play) and estimate how the game changed, controlling for who the teams are:

    margin  : home net rating per 100 possessions   ~ team-season strengths (home +, away -) + home court
                                                       + sum over missing players (+ if his team is home, - if away) x theta_i
    total   : total points                          ~ both teams' season tendencies + sum over missing players x theta_i
    pace    : possessions per 48 (same)
    effic.  : points per 100 possessions, both teams (same)

theta_i is shrunk toward a minutes-based prior (the average cost of missing a player who plays that many minutes), so a player
with few absences is read as "an average player of his minutes" and one with many absences earns his own number. The ridge
strength is chosen by cross-validation on held-out games.

Then the pricing test: how much of that effect is already in the opening and the closing line? (actual - line) is regressed on
the effect estimated for the game's missing players (cross-fitted, so a game never helps predict itself).

    python -m nba_model.impact fit         # estimate, print the study, write data/nba/player_impact.csv
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .parse import GAMES_OUT, ODDS_OUT, PLAYER_GAMES_OUT, TEAM_GAMES_OUT

OUT = DATA_DIR / "player_impact.csv"
MIN_MPG, MIN_GP = 14.0, 15


# --------------------------------------------------------------------------------------------- data

def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    gm = pd.read_csv(GAMES_OUT)
    pg = pd.read_csv(PLAYER_GAMES_OUT)
    od = pd.read_csv(ODDS_OUT) if ODDS_OUT.exists() else pd.DataFrame(columns=["event_id"])
    gm["start_utc"] = pd.to_datetime(gm["start_utc"], utc=True)
    pg["start_utc"] = pd.to_datetime(pg["start_utc"], utc=True)
    return gm, pg, od


def rotation_and_absences(gm: pd.DataFrame, pg: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """rotation: one row per (season, team, player) with avg minutes; out: one row per (event, team, player) he missed."""
    played = pg[pg["min"] > 0]
    rot = (
        played.groupby(["season", "team_id", "player_id"])
        .agg(name=("name", "last"), gp=("event_id", "nunique"), mpg=("min", "mean"))
        .reset_index()
    )
    rot = rot[(rot["mpg"] >= MIN_MPG) & (rot["gp"] >= MIN_GP)].copy()
    rot["f"] = rot["mpg"] / 48.0
    # the window in which he was on that team: first to last game in which he is LISTED (played or did-not-play)
    win = pg.groupby(["season", "team_id", "player_id"])["start_utc"].agg(first="min", last="max").reset_index()
    rot = rot.merge(win, on=["season", "team_id", "player_id"])
    # every game of the team inside the window that he did not play
    tgames = pd.concat(
        [
            gm[["event_id", "season", "start_utc", "home_id"]].rename(columns={"home_id": "team_id"}).assign(is_home=1),
            gm[["event_id", "season", "start_utc", "away_id"]].rename(columns={"away_id": "team_id"}).assign(is_home=0),
        ]
    )
    played_keys = set(zip(played["event_id"], played["team_id"], played["player_id"]))
    reason = pg[pg["dnp"]].set_index(["event_id", "team_id", "player_id"])["reason"].to_dict()
    rows = []
    for r in rot.itertuples():
        g = tgames[(tgames["season"] == r.season) & (tgames["team_id"] == r.team_id) & (tgames["start_utc"] >= r.first) & (tgames["start_utc"] <= r.last)]
        for e in g.itertuples():
            if (e.event_id, r.team_id, r.player_id) not in played_keys:
                rows.append((e.event_id, r.team_id, r.player_id, r.season, e.is_home, reason.get((e.event_id, r.team_id, r.player_id))))
    out = pd.DataFrame(rows, columns=["event_id", "team_id", "player_id", "season", "is_home", "reason"])
    return rot, out


# --------------------------------------------------------------------------------------------- design

class Design:
    """Games x [team-season strengths | home court | player-out columns] for one target."""

    def __init__(self, gm: pd.DataFrame, rot: pd.DataFrame, out: pd.DataFrame, kind: str):
        self.kind = kind
        self.gm = gm.reset_index(drop=True)
        ts = sorted({(s, t) for s, t in zip(gm.season, gm.home_id)} | {(s, t) for s, t in zip(gm.season, gm.away_id)})
        self.ts_idx = {k: i for i, k in enumerate(ts)}
        self.rot = rot.reset_index(drop=True)
        self.p_idx = {(s, t, p): i for i, (s, t, p) in enumerate(zip(rot.season, rot.team_id, rot.player_id))}
        self.n_ts, self.n_p = len(ts), len(rot)
        self.ev_idx = {e: i for i, e in enumerate(self.gm["event_id"])}
        n = len(self.gm)
        X = np.zeros((n, self.n_ts + 1 + self.n_p))
        self.kind_sign = -1.0 if kind in ("margin", "margin_pts") else 1.0
        s = self.gm["season"].to_numpy()
        for i, (se, h, a) in enumerate(zip(s, self.gm.home_id, self.gm.away_id)):
            X[i, self.ts_idx[(se, h)]] = 1.0
            X[i, self.ts_idx[(se, a)]] = -1.0 if kind in ("margin", "margin_pts") else 1.0
        X[:, self.n_ts] = 1.0  # home court (margin) / the league-average level (total, pace, efficiency)
        f = np.zeros(self.n_p)
        f[:] = self.rot["f"].to_numpy()
        self.f = f
        for r in out.itertuples():
            j = self.p_idx.get((r.season, r.team_id, r.player_id))
            i = self.ev_idx.get(r.event_id)
            if j is None or i is None:
                continue
            X[i, self.n_ts + 1 + j] = (1.0 if r.is_home == 1 else -1.0) if kind in ("margin", "margin_pts") else 1.0
        self.X = X

    def target(self) -> np.ndarray:
        g = self.gm
        if self.kind == "margin":
            return ((g.home_pts - g.away_pts) / g.poss * 100.0).to_numpy()
        if self.kind == "total":
            return (g.home_pts + g.away_pts).to_numpy(dtype=float)
        if self.kind == "pace":
            return g.pace.to_numpy(dtype=float)
        if self.kind == "margin_pts":
            return (g.home_pts - g.away_pts).to_numpy(dtype=float)
        return ((g.home_pts + g.away_pts) / g.poss * 100.0).to_numpy()  # efficiency of both teams combined, per 100 possessions


def ridge_solve(X, y, pen, prior):
    """min |y - X b|^2 + sum pen_j (b_j - prior_j)^2  (columns with pen 0 are free)."""
    A = X.T @ X + np.diag(pen)
    b = X.T @ y + pen * prior
    return np.linalg.solve(A, b)


def fit_design(d: Design, lam: float, rows: np.ndarray | None = None, k_prior: float | None = None, y_full: np.ndarray | None = None):
    yy = d.target() if y_full is None else y_full
    X = d.X if rows is None else d.X[rows]
    y = yy if rows is None else yy[rows]
    n_f = d.n_ts + 1
    pen = np.concatenate([np.full(d.n_ts, 1e-3), [0.0], np.full(d.n_p, lam)])
    prior = np.zeros(X.shape[1])
    if k_prior is None:
        # pooled: one coefficient on sum(f_i x_i) = the average cost per unit of minutes share
        S = X[:, n_f:] @ d.f
        Xp = np.c_[X[:, :n_f], S]
        b = np.linalg.solve(Xp.T @ Xp + np.diag(np.concatenate([np.full(d.n_ts, 1e-3), [0.0], [1e-6]])), Xp.T @ y)
        k_prior = float(b[-1])
    prior[n_f:] = k_prior * d.f
    beta = ridge_solve(X, y, pen, prior)
    return beta, k_prior


def cv_lambda(d: Design, lams, folds: int = 5, seed: int = 0) -> dict[float, float]:
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(d.gm))
    parts = np.array_split(idx, folds)
    y = d.target()
    res = {}
    for lam in lams:
        sse = 0.0
        for k in range(folds):
            te = parts[k]
            tr = np.concatenate([parts[j] for j in range(folds) if j != k])
            beta, _ = fit_design(d, lam, rows=tr)
            sse += float(np.sum((y[te] - d.X[te] @ beta) ** 2))
        res[lam] = sse / len(y)
    return res


def crossfit_effect(d: Design, lam: float, folds: int = 5, seed: int = 1) -> np.ndarray:
    """For each game, the effect of its missing players estimated WITHOUT that game (sum of theta_i x_i)."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(d.gm))
    parts = np.array_split(idx, folds)
    n_f = d.n_ts + 1
    eff = np.zeros(len(d.gm))
    for k in range(folds):
        te = parts[k]
        tr = np.concatenate([parts[j] for j in range(folds) if j != k])
        beta, _ = fit_design(d, lam, rows=tr)
        eff[te] = d.X[te][:, n_f:] @ beta[n_f:]
    return eff


# --------------------------------------------------------------------------------------------- the study

def _ols(y: np.ndarray, x: np.ndarray) -> tuple[float, float, float]:
    A = np.c_[np.ones(len(x)), x]
    b = np.linalg.lstsq(A, y, rcond=None)[0]
    r = y - A @ b
    se = np.sqrt(np.diag(np.linalg.inv(A.T @ A) * r.var()))
    return float(b[1]), float(se[1]), float(b[0])


def pricing_test(dm: Design, dt: Design, od: pd.DataFrame, lam_m: float, lam_t: float) -> None:
    gm = dm.gm
    em = crossfit_effect(dm, lam_m) * gm["poss"].to_numpy() / 100.0  # points of margin, home perspective
    et = crossfit_effect(dt, lam_t)  # points of total
    m = gm.assign(eff_margin=em, eff_total=et).merge(od, on="event_id", how="inner")
    m = m.dropna(subset=["spread_home_open", "spread_home_close", "total_open", "total_close"])
    m["actual_margin"] = m["home_pts"] - m["away_pts"]
    m["actual_total"] = m["home_pts"] + m["away_pts"]
    print(f"\n=== Is it priced? ({len(m):,} games with lines; {(m.eff_margin != 0).mean() * 100:.0f}% have a rotation player out)")
    print("slope = how much of the estimated absence effect is STILL in the result after the line (0 = fully priced, 1 = not priced at all)")
    for lab, resid, eff in (
        ("spread, vs OPEN ", m.actual_margin + m.spread_home_open, m.eff_margin),
        ("spread, vs CLOSE", m.actual_margin + m.spread_home_close, m.eff_margin),
        ("total,  vs OPEN ", m.actual_total - m.total_open, m.eff_total),
        ("total,  vs CLOSE", m.actual_total - m.total_close, m.eff_total),
    ):
        s, se, _ = _ols(resid.to_numpy(), eff.to_numpy())
        print(f"  {lab}: {s:+.2f} (se {se:.2f})")
    # how the line moved between open and close when players are out
    for lab, mv, eff in (("spread move (home margin)", (-m.spread_home_close) - (-m.spread_home_open), m.eff_margin), ("total move", m.total_close - m.total_open, m.eff_total)):
        s, se, _ = _ols(mv.to_numpy(), eff.to_numpy())
        print(f"  open->close {lab}: {s:+.2f} per point of estimated effect (se {se:.2f}) - the market moved this share of the way")
    big = m[m.eff_margin.abs() >= 2.0]
    print(f"  games with a >=2-point estimated margin effect: {len(big):,}; avg effect {big.eff_margin.abs().mean():.1f} pts")



def market_vs_actual(gm: pd.DataFrame, rot: pd.DataFrame, out: pd.DataFrame, od: pd.DataFrame, lam: float = 30.0, boots: int = 30) -> None:
    """The same regression on three targets over the same games: the result, the opening line and the closing line. The coefficient
    on a player's absence is what it ACTUALLY cost (result) next to what the market CHARGED for it (open / close)."""
    m = gm.merge(od[["event_id", "spread_home_open", "spread_home_close", "total_open", "total_close"]], on="event_id", how="left")
    have = m[["spread_home_open", "spread_home_close", "total_open", "total_close"]].notna().all(axis=1).to_numpy()
    rows = np.where(have)[0]
    print(f"\n=== What a player is worth vs what the market charges ({len(rows):,} games with open and close lines)")
    res = {}
    for kind, y_act, y_open, y_close in (
        ("margin_pts", (m.home_pts - m.away_pts).to_numpy(float), (-m.spread_home_open).to_numpy(float), (-m.spread_home_close).to_numpy(float)),
        ("total", (m.home_pts + m.away_pts).to_numpy(float), m.total_open.to_numpy(float), m.total_close.to_numpy(float)),
    ):
        d = Design(gm, rot, out, kind)
        n_f = d.n_ts + 1
        base = {}
        for lab, y in (("actual", y_act), ("open", y_open), ("close", y_close)):
            beta, kp = fit_design(d, lam, rows=rows, y_full=y)
            base[lab] = beta[n_f:]
            base[lab + "_k"] = kp
        # bootstrap the ACTUAL effect (games resampled) for error bars
        rng = np.random.default_rng(7)
        bs = np.zeros((boots, d.n_p))
        for b in range(boots):
            samp = rng.choice(rows, size=len(rows), replace=True)
            bs[b] = fit_design(d, lam, rows=samp, y_full=y_act)[0][n_f:]
        base["se"] = bs.std(axis=0)
        res[kind] = (d, base)
        print(f"  {kind}: pooled cost per unit of minutes share  actual {base['actual_k']:+.2f} | open {base['open_k']:+.2f} | close {base['close_k']:+.2f}")

    # pooled: how much of the actual effect is in each line, across all players (weighted by games missed)
    for kind, (d, base) in res.items():
        w = np.array([((out.season == r.season) & (out.team_id == r.team_id) & (out.player_id == r.player_id)).sum() for r in d.rot.itertuples()], float)
        a = base["actual"]
        for lab in ("open", "close"):
            wl = w + 1.0
            slope = float(np.sum(wl * a * base[lab]) / np.sum(wl * a * a))
            print(f"  {kind}: the {lab} line charges {slope * 100:.0f}% of the actual absence effect (across all rotation players)")

    # named stars: actual vs open vs close, with error bars
    names = ["Nikola Jokic", "Stephen Curry", "Kevin Durant", "Joel Embiid", "LeBron James", "Giannis Antetokounmpo", "Luka Doncic", "Jayson Tatum", "Kawhi Leonard", "Anthony Davis", "Trae Young", "Devin Booker"]
    gout = out.groupby(["season", "team_id", "player_id"]).size()
    rows_out = []
    d_m, b_m = res["margin_pts"]
    d_t, b_t = res["total"]
    for nm in names:
        idx = [i for i, r in enumerate(d_m.rot.itertuples()) if nm.split()[-1].lower() in str(r.name).lower().replace("\u010d", "c").replace("\u0107", "c")]
        if not idx:
            continue
        w = np.array([gout.get((d_m.rot.season[i], d_m.rot.team_id[i], d_m.rot.player_id[i]), 0) + 1.0 for i in idx])
        def avg(vec):
            return float(np.average(vec[idx], weights=w))
        rows_out.append(
            {
                "player": nm, "games_out": int(w.sum() - len(idx)),
                "margin_actual": avg(b_m["actual"]), "+-": avg(b_m["se"]), "margin_open": avg(b_m["open"]), "margin_close": avg(b_m["close"]),
                "total_actual": avg(b_t["actual"]), "t+-": avg(b_t["se"]), "total_open": avg(b_t["open"]), "total_close": avg(b_t["close"]),
            }
        )
    print("\n  Points a game: what his absence cost (actual +- one standard error) vs what the opening and closing lines moved. Negative = worse without him.")
    print(pd.DataFrame(rows_out).round(2).to_string(index=False))


def fit(show: int = 25) -> None:
    gm, pg, od = load()
    rot, out = rotation_and_absences(gm, pg)
    print(f"games {len(gm):,} | rotation player-seasons {len(rot):,} | absences (rotation player missed a game) {len(out):,}")
    print("absence reasons:", out["reason"].fillna("not listed").str.replace(r"^(LEFT|RIGHT) ", "", regex=True).value_counts().head(8).to_dict())

    designs = {k: Design(gm, rot, out, k) for k in ("margin", "total", "pace", "eff")}
    lams = [3.0, 10.0, 30.0, 100.0, 300.0]
    best = {}
    for k, d in designs.items():
        cv = cv_lambda(d, lams)
        best[k] = min(cv, key=cv.get)
        print(f"  {k:<7} ridge strength CV (mean squared error): " + ", ".join(f"{l:g}: {v:.3f}" for l, v in cv.items()) + f"  -> {best[k]:g}")

    fits = {}
    for k, d in designs.items():
        beta, kp = fit_design(d, best[k])
        fits[k] = (beta, kp)
    n_f = designs["margin"].n_ts + 1
    print(f"\nPooled price of a missing player per unit of minutes share (f = mpg/48): margin {fits['margin'][1]:+.2f} net-rating pts per 100 | "
          f"total {fits['total'][1]:+.2f} pts | pace {fits['pace'][1]:+.2f} poss | efficiency {fits['eff'][1]:+.2f} pts/100")

    # player table
    r = rot.copy()
    for k in ("margin", "total", "pace", "eff"):
        r[k] = fits[k][0][n_f:]
    r["games_out"] = r.apply(lambda x: int(((out.season == x.season) & (out.team_id == x.team_id) & (out.player_id == x.player_id)).sum()), axis=1)
    r["margin_pts"] = r["margin"] * 1.0  # per 100 possessions ~ points a game (a game is ~100 possessions)
    r.to_csv(OUT, index=False)
    by_player = (
        r.groupby("player_id")
        .apply(
            lambda g: pd.Series(
                {
                    "name": g["name"].iloc[-1], "seasons": len(g), "games_out": int(g.games_out.sum()), "mpg": float(np.average(g.mpg, weights=g.gp)),
                    "margin": float(np.average(g.margin, weights=g.games_out + 5)), "total": float(np.average(g.total, weights=g.games_out + 5)),
                    "pace": float(np.average(g.pace, weights=g.games_out + 5)), "eff": float(np.average(g.eff, weights=g.games_out + 5)),
                }
            )
        )
        .reset_index()
    )
    by_player = by_player[by_player.games_out >= 10].sort_values("margin")
    cols = ["name", "seasons", "games_out", "mpg", "margin", "total", "pace", "eff"]
    print(f"\n=== Players whose absence costs the most margin (>=10 games missed in the data). margin = net-rating pts a game; total = game total pts;")
    print("    pace = possessions per 48; eff = combined points per 100 possessions. Negative margin = team gets worse without him.")
    print(by_player[cols].head(show).round(2).to_string(index=False))
    print("\n=== Total effect: players whose absence moves the total the most (down / up)")
    print(by_player.sort_values("total")[cols].head(8).round(2).to_string(index=False))
    print(by_player.sort_values("total")[cols].tail(8).round(2).to_string(index=False))
    jok = by_player[by_player["name"].str.contains("Jokic|Doncic|Don\u010di\u0107|Embiid|Curry|Giannis|Antetokounmpo|Tatum|Durant|James", regex=True)]
    if len(jok):
        print("\n=== Named stars")
        print(jok[cols].round(2).to_string(index=False))

    if len(od) > 100:
        pricing_test(designs["margin"], designs["total"], od, best["margin"], best["total"])
        market_vs_actual(gm, rot, out, od)
    else:
        print("\n(no odds yet - run python -m nba_model.ingest odds and parse again for the pricing test)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["fit"])
    ap.add_argument("--show", type=int, default=25)
    a = ap.parse_args()
    fit(a.show)


if __name__ == "__main__":
    main()
