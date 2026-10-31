"""Fundamentals Lab v3 (DRAFT, NOT PUBLISHED - see notes.md 2026-10-30 late; the live model is model.py): player-level offence/defence ridge, NBA only (market-blind).
Lineups use only the current stretch of games (no last-season rotation); the margin leans on the team ridge until both teams have SETTLE_GAMES current
games; the total is W_TOT player / rest team ridge. CBB uses the team ridge (its player fit lost on margin; box scores end Apr 2026).

A team's expected score is the sum of what the players expected to play contribute:
  pts_for = mu + home edge + sum_i share_i * o_i (own players) + sum_j share_j * d_j (opposing players)
where share is a player's share of the team's minutes x 5 (so a full-time player is 1.0). Player o/d are fitted with a time-decayed ridge
on player box scores (cbb/player_games.csv.gz, nba/player_games.csv.gz, date-filtered to before pack.asof). The expected lineup is the
decay-weighted minutes share over each team's last few games; in the live NBA slate players on the injury list (g["news"]) are removed
and the rest rescaled. Football and hockey have no usable player box scores here, so they keep v2's team ridge (said so in notes.md).
"""
import numpy as np
import pandas as pd

PORTABLE = False   # reads player box scores through pack.path; the published state is frozen until republished
HALF_LIFE = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 200, "nhl": 120}
LAM = {"nba": 6.0, "cbb": 5.0, "nfl": 8.0, "cfb": 5.0, "nhl": 25.0}
HCA0 = {"nba": 2.8, "cbb": 3.5, "nfl": 2.0, "cfb": 2.5, "nhl": 0.25}
HL_MARGIN = {"nba": 120, "cbb": 100, "nfl": 250, "cfb": 400, "nhl": 120}

PLAYER_SPORTS = ("nba",)                 # CBB player fit lost to the team ridge on margin (2026-10-30) and its box scores end Apr 2026
W_TOT = {"nba": 0.5}                     # share of the total taken from the player model (rest from the team ridge)
P_HL = {"nba": 150, "cbb": 150}          # player rating memory (days)
P_LAM = {"nba": 7.0, "cbb": 3.0}         # ridge penalty per player coefficient (shares are ~0.2-1.0 per player)
T_LAM = {"nba": 1e6, "cbb": 1e6}        # ridge penalty on team effects kept on top of the players (1e6 = off)
P_DAYS = {"nba": 600, "cbb": 600}        # how far back player games are read
LINEUP_GAMES = 6                         # recent team games used for the expected minutes share
LINEUP_DECAY = 0.75
SETTLE_GAMES = 8                         # until both teams have this many current-rotation games the margin leans on the team ridge
STALE_DAYS = 45                          # a team whose last box score is older than this falls back to the team model
OUT_STATUS = {"out": 1.0, "doubtful": 0.85, "questionable": 0.4, "day-to-day": 0.4, "probable": 0.05}


# ---------- team ridge (v2) for sports without player data and as a fallback ----------
def _ridge(g, teams, w, lam_t, target, h0):
    T, n = len(teams), len(g)
    X = np.zeros((2 * n, 2 + 2 * T))
    y = np.zeros(2 * n)
    ww = np.zeros(2 * n)
    hi = g.home_id.map(teams).to_numpy()
    ai = g.away_id.map(teams).to_numpy()
    ha = (~g.neutral.to_numpy()).astype(float)
    for r, (o, d, s, sc) in enumerate(((hi, ai, 1.0, g.home_score.to_numpy()), (ai, hi, -1.0, g.away_score.to_numpy()))):
        rows = np.arange(n) * 2 + r
        X[rows, 0] = 1.0
        X[rows, 1] = s * ha
        X[rows, 2 + o] = 1.0
        X[rows, 2 + T + d] = 1.0
        y[rows] = sc - s * ha * h0
        ww[rows] = w
    lam = np.full(2 + 2 * T, lam_t)
    lam[0], lam[1] = 1e-6, 400.0
    tgt = np.zeros(2 + 2 * T)
    tgt[2:] = target
    A = X.T @ (X * ww[:, None]) + np.diag(lam)
    return np.linalg.solve(A, X.T @ (ww * y) + lam * tgt)


def _team_fit(pack, sp, hl):
    g = pack.games(sp)
    if len(g) < 60:
        return None
    teams = {t: i for i, t in enumerate(sorted(set(g.home_id) | set(g.away_id)))}
    T = len(teams)
    h0 = HCA0[sp] / 2.0
    w = 0.5 ** ((g.start.max() - g.start).dt.total_seconds().to_numpy() / 86400.0 / hl[sp])
    beta = _ridge(g, teams, w, LAM[sp], np.zeros(2 * T), h0)
    return {"mu": float(beta[0]), "hca": float(beta[1]) + h0,
            "o": {t: float(beta[2 + i]) for t, i in teams.items()}, "d": {t: float(beta[2 + T + i]) for t, i in teams.items()}}


# ---------- player model ----------
def _player_fit(pack, sp):
    from scipy import sparse
    from scipy.sparse.linalg import cg

    asof = pack.asof if pack.asof is not None else pd.Timestamp.now(tz="UTC")
    pg = pd.read_csv(pack.path(sp, "player_games.csv.gz"),
                     usecols=["event_id", "start_utc", "team_id", "opp_id", "player_id", "name", "min", "pts"])
    pg["start"] = pd.to_datetime(pg.start_utc, utc=True)
    pg = pg[(pg.start < asof) & (pg.start >= asof - pd.Timedelta(days=P_DAYS[sp]))]
    pg = pg[pg["min"].fillna(0) > 0].dropna(subset=["player_id"])
    if len(pg) < 5000:
        return None
    pg["player_id"] = pg.player_id.astype(np.int64)
    tm = pg.groupby(["event_id", "team_id"])["min"].transform("sum")
    pg["share"] = 5.0 * pg["min"] / tm
    # team-game scores, home side and neutral flag
    tg = pg.groupby(["event_id", "team_id"]).agg(pts=("pts", "sum"), opp=("opp_id", "first"), start=("start", "first")).reset_index()
    tg = tg[tg.groupby("event_id").team_id.transform("size") == 2]
    pk = pack.games(sp)
    eid = pk.id.astype(str).str.split(":").str[-1].astype(np.int64)
    neutral = dict(zip(eid, pk.neutral))
    home_of = dict(zip(eid, pk.home_id.astype(str)))
    if sp == "cbb":
        sch = pd.read_csv(pack.path("cbb", "schedule.csv"), usecols=["event_id", "neutral", "home_id"])
        for e, nt, h in zip(sch.event_id, sch.neutral, sch.home_id):
            neutral.setdefault(int(e), bool(nt))
            home_of.setdefault(int(e), str(h))
    else:
        tgh = pd.read_csv(pack.path("nba", "team_games.csv.gz"), usecols=["event_id", "team_id", "is_home"])
        for e, t in zip(tgh.event_id[tgh.is_home == 1], tgh.team_id[tgh.is_home == 1]):
            home_of.setdefault(int(e), str(t))
    tg["sgn"] = [0.0 if neutral.get(int(e), False) else (1.0 if home_of.get(int(e)) == str(t) else -1.0)
                 for e, t in zip(tg.event_id, tg.team_id)]
    tg = tg[tg.event_id.map(lambda e: int(e) in home_of)]
    tg = tg.reset_index(drop=True)
    players = {p: i for i, p in enumerate(sorted(pg.player_id.unique()))}
    P = len(players)
    row_of = {(e, t): i for i, (e, t) in enumerate(zip(tg.event_id, tg.team_id))}
    n = len(tg)
    # offence entries: player on team t in event e -> row (e,t), column o_p; defence: row (e, opp) column d_p
    ri, ci, vv = [], [], []
    for e, t, o, p, s in zip(pg.event_id, pg.team_id, pg.opp_id, pg.player_id, pg.share):
        r = row_of.get((e, t))
        if r is not None:
            ri.append(r); ci.append(2 + players[p]); vv.append(s)
        r2 = row_of.get((e, o))
        if r2 is not None:
            ri.append(r2); ci.append(2 + P + players[p]); vv.append(s)
    teams = {t: i for i, t in enumerate(sorted(set(tg.team_id) | set(tg.opp)))}
    T = len(teams)
    K = 2 + 2 * P
    ri += list(range(n)) * 4
    ci += [0] * n + [1] * n + [K + teams[t] for t in tg.team_id] + [K + T + teams[t] for t in tg.opp]
    vv += [1.0] * n + list(tg.sgn) + [1.0] * (2 * n)
    X = sparse.csr_matrix((vv, (ri, ci)), shape=(n, K + 2 * T))
    h0 = HCA0[sp] / 2.0
    y = tg.pts.to_numpy(float) - tg.sgn.to_numpy() * h0
    age = (asof - tg.start).dt.total_seconds().to_numpy() / 86400.0
    w = 0.5 ** (age / P_HL[sp])
    lam = np.full(K + 2 * T, P_LAM[sp])
    lam[0], lam[1] = 1e-6, 400.0
    lam[K:] = T_LAM[sp]
    Xw = X.multiply(w[:, None]).tocsr()
    A = (X.T @ Xw + sparse.diags(lam)).tocsr()
    x0 = np.zeros(K + 2 * T)
    x0[0] = float(np.average(y, weights=w))
    beta, _ = cg(A, Xw.T @ y, x0=x0, rtol=1e-8, maxiter=5000)
    o = {p: beta[2 + i] for p, i in players.items()}
    d = {p: beta[2 + P + i] for p, i in players.items()}
    # expected lineup per team: decay-weighted minutes share over its last LINEUP_GAMES games; a player counts only for his latest team
    last_team = pg.sort_values("start").groupby("player_id").team_id.last()
    name_of = pg.sort_values("start").groupby("player_id").name.last().fillna("").astype(str).str.lower()
    lineups = {}
    for t, gt in pg.groupby("team_id"):
        ev = gt.drop_duplicates("event_id").sort_values("start", ascending=False).head(LINEUP_GAMES)
        if (asof - ev.start.iloc[0]).days > STALE_DAYS:
            continue
        ev = ev[(ev.start.iloc[0] - ev.start).dt.days <= STALE_DAYS]   # never mix in last season's rotation
        allev = gt.drop_duplicates("event_id")
        n_cur = int(((allev.start.max() - allev.start).dt.days <= STALE_DAYS).sum())
        wts = {e: LINEUP_DECAY ** k for k, e in enumerate(ev.event_id)}
        sub = gt[gt.event_id.isin(wts)]
        sh = (sub.share * sub.event_id.map(wts)).groupby(sub.player_id).sum() / sum(wts.values())
        sh = sh[[last_team.get(p) == t for p in sh.index]]
        if sh.sum() < 2.5:
            continue
        lineups[str(t)] = {"p": [[name_of.get(p, ""), float(s), float(o[p]), float(d[p])] for p, s in sh.items()],
                           "n": n_cur, "o": float(beta[K + teams[t]]) if t in teams else 0.0, "d": float(beta[K + T + teams[t]]) if t in teams else 0.0}
    return {"mu": float(beta[0]), "hca": float(beta[1]) + h0, "teams": lineups}


def fit(pack):
    state = {"tot": {}, "mar": {}, "pl": {}}
    for sp in pack.sports:
        t = _team_fit(pack, sp, HALF_LIFE)
        if t:
            state["tot"][sp] = t
            state["mar"][sp] = _team_fit(pack, sp, HL_MARGIN)
        if sp in PLAYER_SPORTS:
            p = _player_fit(pack, sp)
            if p:
                state["pl"][sp] = p
    return state


def _avail(news_side):
    miss = {}
    for x in news_side or []:
        st = str(x.get("status") or "").lower()
        f = max([v for k, v in OUT_STATUS.items() if k in st] or [0.0])
        if f > 0:
            miss[str(x.get("player") or "").lower()] = f
    return miss


def _side(team, miss_ids):
    lineup = team["p"]
    sh = np.array([s * (1.0 - miss_ids.get(p, 0.0)) for p, s, _, _ in lineup])
    if sh.sum() <= 0:
        return None
    sh = sh * 5.0 / sh.sum()
    return team["o"] + float(sum(s * x[2] for s, x in zip(sh, lineup))), team["d"] + float(sum(s * x[3] for s, x in zip(sh, lineup)))


def predict(state, games):
    out = {}
    for g in games:
        sp = g["sport"]
        pl = state["pl"].get(sp)
        h, a = str(g["home_id"]), str(g["away_id"])
        if pl and h in pl["teams"] and a in pl["teams"]:
            news = g.get("news") or {}
            sides = [_side(pl["teams"][h], _avail(news.get("home"))), _side(pl["teams"][a], _avail(news.get("away")))]
            if None not in sides:
                (ho, hd), (ao, ad) = sides
                ha = 0.0 if g["neutral"] else pl["hca"]
                hs = pl["mu"] + ha + ho + ad
                as_ = pl["mu"] - ha + ao + hd
                tm = _team(state, g)
                w = W_TOT.get(sp, 1.0)
                wm = min(1.0, min(pl["teams"][h]["n"], pl["teams"][a]["n"]) / SETTLE_GAMES) if tm else 1.0
                out[g["id"]] = [wm * (hs - as_) + (1 - wm) * tm[0] if tm else hs - as_, w * (hs + as_) + (1 - w) * tm[1] if tm else hs + as_]
                continue
        tm = _team(state, g)
        if tm:
            out[g["id"]] = tm
    return out


def _team(state, g):
    tot, mar = state["tot"].get(g["sport"]), state["mar"].get(g["sport"])
    if not tot or g["home_id"] not in tot["o"] or g["away_id"] not in tot["o"]:
        return None
    r = []
    for s in (mar, tot):
        ha = 0.0 if g["neutral"] else s["hca"]
        hs = s["mu"] + ha + s["o"][g["home_id"]] + s["d"][g["away_id"]]
        as_ = s["mu"] - ha + s["o"][g["away_id"]] + s["d"][g["home_id"]]
        r.append((hs - as_, hs + as_))
    return [r[0][0], r[1][1]]
