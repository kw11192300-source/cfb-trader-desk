"""Tempo Lab v1 (market-blind): possessions x efficiency, CBB only.

Two separate regularised fits on box scores (cbb/team_games.csv.gz, date-filtered to the pack's asof):
- tempo:      possessions in a game = league mean + home tempo effect + away tempo effect (both teams shape pace)
- efficiency: points per 100 possessions = league mean + offence + opponent defence + home edge (weighted by possessions)
Prediction: poss = tempo fit; each side's points = poss * its efficiency / 100. So the total comes from pace times scoring rate, and the
margin scales with expected possessions (a quality gap is worth more in a fast game), unlike a ratings fit on final scores.
Other sports abstain (no box scores for the current NBA season in the pack; nothing for football/hockey in this lens yet).
"""
import numpy as np
import pandas as pd
import scipy.sparse as sp_
import scipy.sparse.linalg as spla

PORTABLE = False            # reads cbb/team_games.csv.gz through pack.path
HL = 150.0                  # half-life in days for weighting past games
LAM_T = 1.0                 # ridge strength on team tempo effects (in game-weight units; by March light shrinkage wins)
LAM_E = 0.5                 # ridge strength on team efficiency effects
HCA0 = 1.6                  # prior home edge, points per 100 possessions per side
NEW_SEASON_RHO_T = 0.8      # share of last season's tempo effect kept when a new season starts (pace is a coach trait)
NEW_SEASON_RHO_E = 0.6      # share of last season's efficiency effect kept
SEASONS_BACK = 2            # seasons of box scores used
STYLE = False                # v2: style-matchup residual terms on the total
PRIOR_N = 5.0               # games of league-average style blended into each team's rates
LAM_S = 200.0               # ridge on the (standardised) style coefficients, in units of average game weight
# style rates: (numerator columns, denominator columns), offence view; the defence view swaps team and opp_ columns
RATES = {"tp": (["tpa"], ["fga"]),                          # three-point attempt rate
         "or": (["oreb"], ["oreb", "opp_dreb"]),            # offensive rebound share
         "to": (["tov"], ["fga", "fta", "tov"]),            # turnover share of plays (FTA unweighted, it is only a style index)
         "ft": (["fta"], ["fga"])}                          # free-throw rate (fouls drawn)


def _season(ts):
    return ts.year if ts.month >= 10 else ts.year - 1


def _solve(rows, cols, vals, y, w, ncol, lam):
    X = sp_.csr_matrix((vals.astype(float), (rows, cols)), shape=(len(y), ncol), dtype=float)
    W = sp_.diags(w.astype(float))
    A = (X.T @ W @ X + sp_.diags(lam)).tocsc()
    return spla.spsolve(A, X.T @ (w * y))


def fit(pack):
    g = pack.games("cbb")
    if len(g) < 200:
        return {}
    asof = pack.asof if pack.asof is not None else g.start.max() + pd.Timedelta(seconds=1)
    tg = pd.read_csv(pack.path("cbb", "team_games.csv.gz"),
                     usecols=["event_id", "season", "start_utc", "team_id", "opp_id", "is_home", "neutral", "pts", "opp_pts", "poss"]
                     + [c for b in ("", "opp_") for c in (b + "fga", b + "tpa", b + "fta", b + "oreb", b + "dreb", b + "tov")])
    tg["start"] = pd.to_datetime(tg.start_utc, utc=True)
    tg = tg[(tg.start < asof) & (tg.poss > 40) & tg.pts.notna() & tg.opp_pts.notna() & tg.fga.notna() & tg.opp_fga.notna()]
    tg = tg.fillna(0.0)
    last = int(tg.season.max())
    tg = tg[tg.season > last - SEASONS_BACK].copy()
    tg["team_id"] = tg.team_id.astype(str)
    tg["opp_id"] = tg.opp_id.astype(str)
    age = (asof - tg.start).dt.total_seconds().to_numpy() / 86400.0
    tg["w"] = 0.5 ** (age / HL)
    teams = sorted(set(tg.team_id) | set(tg.opp_id))
    ix = {t: i for i, t in enumerate(teams)}
    T = len(teams)

    # efficiency: one row per team-game
    n = len(tg)
    o = tg.team_id.map(ix).to_numpy()
    d = tg.opp_id.map(ix).to_numpy()
    side = np.where(tg.neutral.to_numpy() == 1, 0.0, np.where(tg.is_home.to_numpy() == 1, 1.0, -1.0))
    ppp = 100.0 * tg.pts.to_numpy() / tg.poss.to_numpy()
    r = np.arange(n)
    rows = np.concatenate([r, r, r, r])
    cols = np.concatenate([np.zeros(n, int), np.ones(n, int), 2 + o, 2 + T + d])
    vals = np.concatenate([np.ones(n), side, np.ones(n), np.ones(n)])
    y = ppp - side * HCA0
    w = tg.w.to_numpy() * tg.poss.to_numpy() / 70.0
    lam = np.full(2 + 2 * T, LAM_E)
    lam[0], lam[1] = 1e-6, 200.0
    be = _solve(rows, cols, vals, y, w, 2 + 2 * T, lam)

    # tempo: one row per game (home-perspective rows, or the first listed team for neutrals)
    gm = tg.sort_values(["event_id", "is_home"], ascending=[True, False]).drop_duplicates("event_id")
    m = len(gm)
    a = gm.team_id.map(ix).to_numpy()
    b = gm.opp_id.map(ix).to_numpy()
    r = np.arange(m)
    rows = np.concatenate([r, r, r])
    cols = np.concatenate([np.zeros(m, int), 1 + a, 1 + b])
    vals = np.ones(3 * m)
    lam = np.full(1 + T, LAM_T)
    lam[0] = 1e-6
    bt = _solve(rows, cols, vals, gm.poss.to_numpy(), gm.w.to_numpy(), 1 + T, lam)

    # teams with very little recent box-score evidence are not priced
    cnt = pd.concat([tg.team_id]).value_counts()
    seen = [t for t in teams if cnt.get(t, 0) >= 8]
    st = {"season": last, "mu_e": float(be[0]), "hca": float(be[1]) + HCA0, "mu_t": float(bt[0]),
          "o": {t: float(be[2 + ix[t]]) for t in seen}, "d": {t: float(be[2 + T + ix[t]]) for t in seen},
          "t": {t: float(bt[1 + ix[t]]) for t in seen}}
    if STYLE:
        st.update(_style(tg, st, seen))
    return {"cbb": st}


def _prof(tg, seen):
    """Weighted per-team style rates, offence and what the defence allows, as deviations from the league."""
    def flip(c):
        return c[4:] if c.startswith("opp_") else "opp_" + c

    x = tg[["team_id", "w"]].copy()
    for k, (num, den) in RATES.items():
        for p, nn, dd in ((k, num, den), ("a" + k, [flip(c) for c in num], [flip(c) for c in den])):
            x[p + "_n"] = tg[nn].to_numpy().sum(1) * x.w
            x[p + "_d"] = tg[dd].to_numpy().sum(1) * x.w
    s = x.groupby("team_id").sum()
    out = {}
    for k in RATES:
        for p in (k, "a" + k):
            lg = s[p + "_n"].sum() / s[p + "_d"].sum()
            dbar = s[p + "_d"] / s.w.clip(lower=1e-9)          # typical denominator per game, so PRIOR_N is in games
            r = (s[p + "_n"] + PRIOR_N * lg * dbar) / (s[p + "_d"] + PRIOR_N * dbar)
            out[p] = {t: float(r.get(t, lg) - lg) for t in seen}
    return out


def _feats(st, h, a):
    """Style-matchup features for one game: each side's offence rate times the other defence's allowed rate, summed both ways,
    plus the pace mismatch (|tempo gap|)."""
    p = st["prof"]
    f = [p[k][h] * p["a" + k][a] + p[k][a] * p["a" + k][h] for k in RATES]
    f.append(abs(st["t"][h] - st["t"][a]))
    return f


def _style(tg, st, seen):
    """Fit total-score residuals of the base model on style-matchup features with a heavy ridge."""
    prof = _prof(tg, seen)
    tmp = {**st, "prof": prof}
    gm = tg[tg.team_id.isin(seen) & tg.opp_id.isin(seen)]
    gm = gm.sort_values(["event_id", "is_home"], ascending=[True, False]).drop_duplicates("event_id")
    F, y, w = [], [], []
    for r in gm.itertuples(index=False):
        h, a = r.team_id, r.opp_id
        poss = st["mu_t"] + st["t"][h] + st["t"][a]
        tot = poss * (2 * st["mu_e"] + st["o"][h] + st["d"][a] + st["o"][a] + st["d"][h]) / 100.0
        F.append(_feats(tmp, h, a))
        y.append(r.pts + r.opp_pts - tot)
        w.append(r.w)
    F, y, w = np.array(F), np.array(y), np.array(w)
    sd = F.std(0) + 1e-9
    mu = F.mean(0)
    Z = (F - mu) / sd
    A = Z.T @ (Z * w[:, None]) + LAM_S * w.sum() / len(w) * np.eye(Z.shape[1])
    beta = np.linalg.solve(A, Z.T @ (w * (y - np.average(y, weights=w))))
    return {"prof": prof, "s_mu": mu.tolist(), "s_sd": sd.tolist(), "s_beta": beta.tolist()}


def predict(state, games):
    out = {}
    for g in games:
        s = state.get(g["sport"]) if g["sport"] == "cbb" else None
        h, a = str(g["home_id"]), str(g["away_id"])
        if not s or h not in s["o"] or a not in s["o"]:
            continue
        new = _season(pd.Timestamp(g["start"])) > s["season"]
        rt, re = (NEW_SEASON_RHO_T, NEW_SEASON_RHO_E) if new else (1.0, 1.0)
        poss = s["mu_t"] + rt * (s["t"][h] + s["t"][a])
        ha = 0.0 if g["neutral"] else s["hca"]
        eh = s["mu_e"] + ha + re * (s["o"][h] + s["d"][a])
        ea = s["mu_e"] - ha + re * (s["o"][a] + s["d"][h])
        ph, pa = poss * eh / 100.0, poss * ea / 100.0
        tot = ph + pa
        if "s_beta" in s and not new:
            z = (np.array(_feats(s, h, a)) - np.array(s["s_mu"])) / np.array(s["s_sd"])
            tot += float(z @ np.array(s["s_beta"]))
        out[g["id"]] = [ph - pa, tot]
    return out
