"""Injury Lab v1: NBA only, market-blind. Who is playing.

- Each player gets a value: shrunk Game Score per minute above replacement, times his recent minutes (box scores before the cut only).
- For every past team-game, M = summed value of rotation players (played in the team's last 10 games) who did not play.
- Team ratings are fitted at FULL strength: margin = hca + r_home - r_away - B*(M_home - M_away); total = mu + t_home + t_away - G*(M_home + M_away).
  B and G are learned with the ratings, so absences are not baked into the ratings.
- At prediction time M comes from the pre-game injury list: g["news"] live (ESPN), or in backtests the official NBA injury report issued at
  least 30 minutes before tip (stored in the state only for games after the cut). Status weights: Out 1, Doubtful .85, Questionable/Day-To-Day .4,
  Probable .05. Only players in the team's stored rotation count (long absences are already in the ratings). No list: league-typical M.
- The list moves the MARGIN only. Totals use league-typical M for both teams: a list-based total adjustment hurt in the Apr-Jun 2026 block.
- Other sports: abstain.
"""
import re
import unicodedata

import numpy as np
import pandas as pd

PORTABLE = False
HL = 120.0          # days, rating memory
LAM = 6.0           # ridge on team ratings
LAM_B = 2.0         # ridge on the injury coefficients
HCA0 = 2.8
SHRINK_MIN = 300.0  # minutes of league-average play added to every player's Game Score rate
REPL_Q = 0.2        # replacement level = this quantile of rotation players' rate
ROT_GAMES = 10
STATUS_W = {"out": 1.0, "doubtful": 0.85, "questionable": 0.4, "day-to-day": 0.4, "probable": 0.05}


def _norm(name):
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def _gmsc(d):
    return (d.pts + 0.4 * d.fgm - 0.7 * d.fga - 0.4 * (d.fta - d.ftm) + 0.7 * d.oreb + 0.3 * d.dreb + d.stl + 0.7 * d.ast + 0.7 * d.blk - 0.4 * d.pf - d.tov)


def _players(pack, asof):
    cols = ["event_id", "start_utc", "team_id", "player_id", "name", "dnp", "min", "pts", "fgm", "fga", "ftm", "fta", "oreb", "dreb", "stl", "ast", "blk", "pf", "tov"]
    pg = pd.read_csv(pack.path("nba", "player_games.csv.gz"), usecols=cols)
    pg["start"] = pd.to_datetime(pg.start_utc, utc=True)
    pg = pg[(pg.start < asof) & (pg.start >= asof - pd.Timedelta(days=500))].copy()
    pg["min"] = pg["min"].fillna(0.0)
    pg["played"] = (~pg.dnp.fillna(False).astype(bool)) & (pg["min"] > 0)
    pg["gs"] = _gmsc(pg.fillna(0.0)).where(pg.played, 0.0)
    pg["key"] = pg.name.map(_norm)
    return pg


def _values(pg, asof):
    """Game Score per minute, decayed (HL 200 days) and shrunk to the league rate; value per minute above replacement."""
    p = pg[pg.played]
    w = 0.5 ** ((asof - p.start).dt.total_seconds() / 86400.0 / 200.0)
    agg = pd.DataFrame({"gs": p.gs * w, "mn": p["min"] * w, "key": p.key}).groupby("key").sum()
    lg = agg.gs.sum() / agg.mn.sum()
    q = (agg.gs + SHRINK_MIN * lg) / (agg.mn + SHRINK_MIN)
    rep = float(q[agg.mn > 500].quantile(REPL_Q)) if (agg.mn > 500).sum() > 20 else float(lg) * 0.7
    return (q - rep).clip(lower=-0.05).to_dict()


def _absences(pg, val):
    """M per (event_id, team_id) from actual availability, plus each team's current rotation (key -> expected minutes)."""
    M, rot = {}, {}
    for tid, t in pg.sort_values("start").groupby("team_id"):
        hist = []   # list of dicts key->minutes for the team's previous games
        for eid, gg in t.groupby("event_id", sort=False):
            exp = {}
            for h in hist[-ROT_GAMES:]:
                for k, m in h.items():
                    exp.setdefault(k, []).append(m)
            played = set(gg.key[gg.played])
            m_abs = 0.0
            for k, ms in exp.items():
                if k not in played and len(ms) >= 2:
                    m_abs += val.get(k, 0.0) * float(np.mean(ms))
            M[(int(eid), int(tid))] = m_abs
            hist.append(dict(zip(gg.key[gg.played], gg["min"][gg.played])))
        exp = {}
        for h in hist[-ROT_GAMES:]:
            for k, m in h.items():
                exp.setdefault(k, []).append(m)
        rot[int(tid)] = {k: float(np.mean(ms)) for k, ms in exp.items() if len(ms) >= 2}
    return M, rot


def _reports(pack, asof, names):
    """Pre-game injury lists for games at or after the cut (what the live news field gives), keyed 'YYYY-MM-DD|team name' (ET date)."""
    f = pack.path("nba", "injury_reports.csv.gz")
    try:
        ir = pd.read_csv(f)
    except Exception:
        return {}
    ir = ir.dropna(subset=["player", "team"])
    ir["rt"] = pd.to_datetime(ir.report_time, utc=True)
    ir["gd"] = pd.to_datetime(ir.game_date, format="%m/%d/%Y").dt.strftime("%Y-%m-%d")
    hh = ir.game_time_et.str.extract(r"(\d+):(\d+)").astype(float)
    tip = pd.to_datetime(ir.gd) + pd.to_timedelta((hh[0] % 12 + 12) * 60 + hh[1], unit="m")   # evening ET
    ir["tip"] = tip.dt.tz_localize("America/New_York", ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
    ir = ir[(ir.tip >= asof) & (ir.rt <= ir.tip - pd.Timedelta(minutes=30))]
    if ir.empty:
        return {}
    last = ir.groupby(["gd", "team"]).rt.transform("max")
    ir = ir[ir.rt == last]
    out = {}
    for (gd, team), x in ir.groupby(["gd", "team"]):
        out[f"{gd}|{team}"] = [[p, s] for p, s in zip(x.player, x.status)]
    return out


def _ridge_fit(X, y, w, lam):
    A = X.T @ (X * w[:, None]) + np.diag(lam)
    return np.linalg.solve(A, X.T @ (w * y))


def fit(pack):
    g = pack.games("nba")
    if len(g) < 200:
        return {}
    asof = g.start.max() + pd.Timedelta(seconds=1)
    pg = _players(pack, asof)
    val = _values(pg, asof)
    M, rot = _absences(pg, val)
    g = g.copy()
    eid = g.id.str.split(":").str[1].astype(int)
    g["mh"] = [M.get((e, int(h)), np.nan) for e, h in zip(eid, g.home_id)]
    g["ma"] = [M.get((e, int(a)), np.nan) for e, a in zip(eid, g.away_id)]
    known = g.mh.notna() & g.ma.notna()
    typ = float(np.nanmean(np.r_[g.mh[known], g.ma[known]])) if known.any() else 0.0
    teams = {t: i for i, t in enumerate(sorted(set(g.home_id) | set(g.away_id)))}
    T, n = len(teams), len(g)
    hi, ai = g.home_id.map(teams).to_numpy(), g.away_id.map(teams).to_numpy()
    ha = (~g.neutral.to_numpy()).astype(float)
    w = 0.5 ** ((asof - g.start).dt.total_seconds().to_numpy() / 86400.0 / HL)
    dM = np.where(known, g.mh.fillna(0) - g.ma.fillna(0), 0.0)
    sM = np.where(known, g.mh.fillna(0) + g.ma.fillna(0), 2 * typ)
    # margin: [hca, B, r_1..r_T]
    X = np.zeros((n, 2 + T))
    X[:, 0] = ha
    X[:, 1] = -dM
    X[np.arange(n), 2 + hi] += 1.0
    X[np.arange(n), 2 + ai] -= 1.0
    y = (g.home_score - g.away_score).to_numpy(float) - ha * HCA0
    lam = np.r_[50.0, LAM_B, np.full(T, LAM)]
    bm = _ridge_fit(X, y, w, lam)
    # total: [mu, G, t_1..t_T]
    Xt = np.zeros((n, 2 + T))
    Xt[:, 0] = 1.0
    Xt[:, 1] = -sM
    Xt[np.arange(n), 2 + hi] += 1.0
    Xt[np.arange(n), 2 + ai] += 1.0
    yt = (g.home_score + g.away_score).to_numpy(float)
    bt = _ridge_fit(Xt, yt, w, np.r_[1e-6, LAM_B, np.full(T, LAM)])
    # rotation values per team: key -> value * expected minutes
    rv = {str(t): {k: round(val.get(k, 0.0) * m, 3) for k, m in r.items()} for t, r in rot.items()}
    return {"nba": {"hca": float(bm[0]) + HCA0, "B": float(bm[1]), "mu": float(bt[0]), "G": float(bt[1]), "typ": typ,
                    "r": {str(t): float(bm[2 + i]) for t, i in teams.items()}, "t": {str(t): float(bt[2 + i]) for t, i in teams.items()},
                    "rot": rv, "rep": _reports(pack, asof, None), "last_box": str(pg.start.max())}}


def _m_from_list(lst, rot):
    m = 0.0
    for e in lst or []:
        name, status = (e.get("player"), e.get("status")) if isinstance(e, dict) else (e[0], e[1])
        wgt = STATUS_W.get(str(status or "").strip().lower(), 0.0)
        m += wgt * rot.get(_norm(name), 0.0)
    return m


def predict(state, games):
    s = state.get("nba") if state else None
    out = {}
    if not s:
        return out
    for g in games:
        if g.get("sport") != "nba":
            continue
        h, a = str(g["home_id"]), str(g["away_id"])
        if h not in s["r"] or a not in s["r"]:
            continue
        news = g.get("news") or {}
        et = pd.Timestamp(g["start"]).tz_convert("America/New_York").strftime("%Y-%m-%d") if pd.Timestamp(g["start"]).tzinfo else pd.Timestamp(g["start"]).tz_localize("UTC").tz_convert("America/New_York").strftime("%Y-%m-%d")
        ms = []
        rep_game = any(f"{et}|{g.get(k)}" in s["rep"] for k in ("home_name", "away_name"))
        for side, tid, nm in (("home", h, g.get("home_name")), ("away", a, g.get("away_name"))):
            rot = s["rot"].get(tid, {})
            lst = news.get(side)
            if lst is None or (not lst and not news):
                lst = s["rep"].get(f"{et}|{nm}", [] if rep_game else None)
            ms.append(_m_from_list(lst, rot) if lst is not None else s["typ"])
        ha = 0.0 if g.get("neutral") else s["hca"]
        mar = ha + s["r"][h] - s["r"][a] - s["B"] * (ms[0] - ms[1])
        tot = s["mu"] + s["t"][h] + s["t"][a] - s["G"] * 2 * s["typ"]   # list-based total adjustment lost to this in backtests (rest-heavy lists don't lower scoring)
        out[g["id"]] = [float(mar), float(tot)]
    return out
