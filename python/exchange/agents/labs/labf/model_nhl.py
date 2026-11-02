"""Fundamentals Lab v3: player-level offence/defence ridge, NBA only (market-blind). PORTABLE via fit(pack, prev): the hosted job refits the team ridge and keeps the player layer from prev.
Lineups use only the current stretch of games (no last-season rotation); the margin leans on the team ridge until both teams have SETTLE_GAMES current
games; the total is W_TOT player / rest team ridge. CBB uses the team ridge (its player fit lost on margin; box scores end Apr 2026).

A team's expected score is the sum of what the players expected to play contribute:
  pts_for = mu + home edge + sum_i share_i * o_i (own players) + sum_j share_j * d_j (opposing players)
where share is a player's share of the team's minutes x 5 (so a full-time player is 1.0). Player o/d are fitted with a time-decayed ridge
on player box scores (cbb/player_games.csv.gz, nba/player_games.csv.gz, date-filtered to before pack.asof). The expected lineup is the
decay-weighted minutes share over each team's last few games; in the live NBA slate players on the injury list (g["news"]) are removed
and the rest rescaled. Football has no usable player data here, so it keeps v2's team ridge (said so in notes.md).
NHL (v4): the team ridge shrinks toward a roster prior instead of 0: skater 5v5 xG/60 offence/defence ratings (ridge on nhl/stints_5v5.csv.gz, date-filtered)
summed over each team's current skaters by TOI share. The stint files end 2026-10-09, so live the rosters/ratings are as of then; kept from prev in the hosted job.
"""
import numpy as np
import pandas as pd

PORTABLE = True    # the hosted job refits the team ridge from ESPN results; the player layer (box scores via pack.path) is kept from prev there
NEW_MIN = 400.0    # minutes of history after which a player is no longer "new"
NEW_O = 0.0        # prior offence of a brand-new player per full-time share (tried -2.5/-5 on 2025-10..12: within noise, so off)
NEW_D = 0.0        # prior points allowed of a brand-new player
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

# NHL roster prior: skater 5v5 xG ratings (ridge on nhl/stints_5v5.csv.gz) summed over each team's current skaters become the target the NHL team ridge shrinks toward
NHL_PRIOR = True
NHL_SK_LAM = 1000.0      # ridge penalty on skater xG/60 coefficients (weights are 5v5 minutes x decay; 300/500/1000/3000 tried, 1000 chosen)
NHL_SK_HL = 365.0        # skater rating memory (days)
NHL_SK_DAYS = 1100       # how far back stints are read
NHL_EV_MIN = 48.0        # 5v5 minutes per game: xG/60 impact -> goals per game
NHL_SCALE = 1.5          # multiplier on the prior (xG misses finishing, goalies and special teams; 1/1.5/2 tried)
NHL_ROSTER_GAMES = 10    # team games used for the skater TOI shares


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


def _team_fit(pack, sp, hl, prior=None):
    g = pack.games(sp)
    if len(g) < 60:
        return None
    teams = {t: i for i, t in enumerate(sorted(set(g.home_id) | set(g.away_id)))}
    T = len(teams)
    h0 = HCA0[sp] / 2.0
    w = 0.5 ** ((g.start.max() - g.start).dt.total_seconds().to_numpy() / 86400.0 / hl[sp])
    tgt = np.zeros(2 * T)
    if prior:
        for t, i in teams.items():
            o, d = prior.get(str(t), (0.0, 0.0))
            tgt[i], tgt[T + i] = NHL_SCALE * o, NHL_SCALE * d
    beta = _ridge(g, teams, w, LAM[sp], tgt, h0)
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
    # players with little history shrink toward a below-average target instead of 0 (rookies, call-ups); fades out by NEW_MIN minutes
    mins = pg.groupby("player_id")["min"].sum()
    newness = np.array([max(0.0, 1.0 - mins.get(p, 0.0) / NEW_MIN) for p in players])
    tgt = np.zeros(K + 2 * T)
    tgt[2:2 + P] = NEW_O * newness
    tgt[2 + P:K] = NEW_D * newness
    Xw = X.multiply(w[:, None]).tocsr()
    A = (X.T @ Xw + sparse.diags(lam)).tocsr()
    x0 = tgt.copy()
    x0[0] = float(np.average(y, weights=w))
    beta, _ = cg(A, Xw.T @ y + lam * tgt, x0=x0, rtol=1e-8, maxiter=5000)
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


def _nhl_prior(pack):
    """{espn team id: (o, d)} in goals per game from the team's current skaters' 5v5 xG ratings; None when the files are missing."""
    from scipy import sparse
    from scipy.sparse.linalg import cg

    need = [pack.path("nhl", f) for f in ("stints_5v5.csv.gz", "games.csv.gz", "espn_events.csv")]
    if not all(p.exists() for p in need):
        return None
    asof = pack.asof if pack.asof is not None else pd.Timestamp.now(tz="UTC")
    gm = pd.read_csv(need[1], usecols=["game_id", "start_utc", "home_abbrev", "away_abbrev"])
    gm["start"] = pd.to_datetime(gm.start_utc, utc=True)
    gm = gm[(gm.start < asof) & (gm.start >= asof - pd.Timedelta(days=NHL_SK_DAYS))].set_index("game_id")
    st = pd.read_csv(need[0])
    st = st[st.game_id.isin(gm.index) & (st.dur > 0)]
    if len(st) < 50000:
        return None
    hcols, acols = ["h0", "h1", "h2", "h3", "h4"], ["a0", "a1", "a2", "a3", "a4"]
    H, A = st[hcols].to_numpy(np.int64), st[acols].to_numpy(np.int64)
    players = np.unique(np.concatenate([H.ravel(), A.ravel()]))
    P = len(players)
    hi, ai = np.searchsorted(players, H), np.searchsorted(players, A)
    n = len(st)
    dur = st.dur.to_numpy(float)
    age = (asof - gm.start.reindex(st.game_id).to_numpy()) / pd.Timedelta(days=1)
    w = dur / 60.0 * 0.5 ** (np.asarray(age, float) / NHL_SK_HL)
    # row r (home attacking): xg_home rate = mu + off(home skaters) + def(away skaters); row n+r the mirror
    rows = np.repeat(np.arange(2 * n), 5)
    cols_o = np.concatenate([hi, ai]).ravel()
    cols_d = np.concatenate([ai, hi]).ravel() + P
    X = sparse.csr_matrix((np.ones(20 * n), (np.concatenate([rows, rows]), np.concatenate([cols_o, cols_d]))), shape=(2 * n, 2 * P))
    y = np.concatenate([st.xg_home.to_numpy(float), st.xg_away.to_numpy(float)]) / np.concatenate([dur, dur]) * 3600.0
    ww = np.concatenate([w, w])
    mu = float(np.average(y, weights=ww))
    Xw = X.multiply(ww[:, None]).tocsr()
    A_ = (X.T @ Xw + sparse.identity(2 * P) * NHL_SK_LAM).tocsr()
    beta, _ = cg(A_, Xw.T @ (y - mu), rtol=1e-8, maxiter=3000)
    off, dfn = beta[:P], beta[P:]
    # rosters: each skater's TOI share over his latest team's last NHL_ROSTER_GAMES games
    gids = st.game_id.to_numpy()
    side = pd.DataFrame({"game_id": np.concatenate([np.repeat(gids, 5), np.repeat(gids, 5)]),
                         "home": np.concatenate([np.ones(5 * n, bool), np.zeros(5 * n, bool)]),
                         "pi": np.concatenate([hi.ravel(), ai.ravel()]), "dur": np.concatenate([np.repeat(dur, 5), np.repeat(dur, 5)])})
    side = side.groupby(["game_id", "home", "pi"], as_index=False).dur.sum()
    side["team"] = np.where(side.home, gm.home_abbrev.reindex(side.game_id).to_numpy(), gm.away_abbrev.reindex(side.game_id).to_numpy())
    side["start"] = gm.start.reindex(side.game_id).to_numpy()
    last_team = side.sort_values("start").groupby("pi").team.last()
    ev = pd.read_csv(need[2], usecols=["espn_id", "home_abbrev"])
    pk = pack.games("nhl")
    eid = pk.id.astype(str).str.split(":").str[-1].astype(np.int64)
    ab2id = pd.DataFrame({"espn_id": eid, "home_id": pk.home_id.astype(str)}).merge(ev, on="espn_id").groupby("home_abbrev").home_id.agg(lambda s: s.mode().iloc[0]).to_dict()
    raw = {}
    for t, gt in side.groupby("team"):
        if t not in ab2id:
            continue
        recent = gt.drop_duplicates("game_id").nlargest(NHL_ROSTER_GAMES, "start").game_id
        sub = gt[gt.game_id.isin(recent)]
        sh = sub.groupby("pi").dur.sum()
        sh = sh[[last_team.get(p) == t for p in sh.index]]
        if sh.sum() <= 0:
            continue
        sh = 5.0 * sh / sh.sum()    # five skater slots: a skater on the ice half the 5v5 time has share 0.5
        o = float((sh * off[sh.index]).sum()) * NHL_EV_MIN / 60.0
        d = float((sh * dfn[sh.index]).sum()) * NHL_EV_MIN / 60.0
        raw[ab2id[t]] = (o, d)
    if len(raw) < 20:
        return None
    mo, md = np.mean([v[0] for v in raw.values()]), np.mean([v[1] for v in raw.values()])
    return {t: (o - mo, d - md) for t, (o, d) in raw.items()}


def fit(pack, prev=None):
    """The team ridge refits from the ESPN results everywhere. The player layer refits only where its box scores exist (my own sessions);
    in the hosted job they are missing, so the player layer is kept from `prev`."""
    state = {"tot": {}, "mar": {}, "pl": {}}
    old = (prev or {}).get("pl") or {}
    if NHL_PRIOR and "nhl" in pack.sports:
        state["nhlp"] = _nhl_prior(pack) or (prev or {}).get("nhlp")
    for sp in pack.sports:
        pr = state.get("nhlp") if sp == "nhl" else None
        t = _team_fit(pack, sp, HALF_LIFE, pr)
        if t:
            state["tot"][sp] = t
            state["mar"][sp] = _team_fit(pack, sp, HL_MARGIN, pr)
        if sp in PLAYER_SPORTS:
            p = _player_fit(pack, sp) if pack.path(sp, "player_games.csv.gz").exists() else None
            if p:
                state["pl"][sp] = p
            elif sp in old:
                state["pl"][sp] = old[sp]
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
