"""
Who will start in goal? A usage model, trained on every NHL game since 2015-16.

The simulator needs a probability that each plausible goalie starts. The first version used a fixed rule (ESPN's
"expected" goalie 75%, the next most-used 25%). This replaces the guess with a model of how coaches actually rotate
goalies, from the thing that decides it most - recent usage and rest:

  for a team and one candidate goalie, before a game:
    did he start the last game / how many of the last 5, 10, 20 / how many days since his last start
    is this the second night of a back-to-back / how many games in the last 7 days
    his share of the team's starts this season (last season's, early on)

A gradient-boosted classifier scores each candidate, and scores are normalised within the game so they sum to 1.
Validated walk-forward by season (train on earlier seasons, score the next) against the old 75/25 rule.

    python -m nhl_model.goalie_usage          # fit, validate, print
"""
from __future__ import annotations

import warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

from .parse import GAMES_OUT

warnings.filterwarnings("ignore")

WINDOW = 20  # candidates are whoever started one of the team's last 20 games
FEATURES = [
    "started_last", "starts_last3", "starts_last5", "starts_last10", "starts_last20", "days_since_start",
    "b2b", "rest_days", "games_last7", "season_share", "starts_in_row", "is_top_share", "goalies_in_window",
]


def team_game_table() -> pd.DataFrame:
    """One row per (team, game): start time and the goalie who started (first to face a shot)."""
    g = pd.read_csv(GAMES_OUT, usecols=["game_id", "season", "start_utc", "home_team_id", "away_team_id", "home_goalie", "away_goalie"])
    g["t"] = pd.to_datetime(g["start_utc"], utc=True)
    g["season"] = g["season"] // 10000  # 20152016 -> 2015, matching the rest of the model
    h = g.rename(columns={"home_team_id": "team", "home_goalie": "starter"})[["game_id", "season", "t", "team", "starter"]]
    a = g.rename(columns={"away_team_id": "team", "away_goalie": "starter"})[["game_id", "season", "t", "team", "starter"]]
    out = pd.concat([h, a]).dropna(subset=["starter"]).sort_values(["team", "t", "game_id"]).reset_index(drop=True)
    out["starter"] = out["starter"].astype(int)
    return out


def _feature_rows(hist: deque, season_starts, season_games, t: pd.Timestamp, season: int) -> list[tuple]:
    """(goalie, *features) for every candidate before a game at time `t`, given the team's history so far."""
    if len(hist) < 3:
        return []
    starters = [s for _, s in hist]
    rest_days = (t - hist[-1][0]).total_seconds() / 86400.0
    b2b = 1.0 if rest_days < 1.5 else 0.0
    g7 = sum(1 for (ht, _) in hist if (t - ht).total_seconds() <= 7 * 86400)
    cands = set(starters)
    # share of the team's starts this season, falling back toward last season's early on
    prior = season_starts.get(season, {})
    n_this = season_games.get(season, 0)
    if n_this < 8:
        prior_prev = season_starts.get(season - 1, {})
        n_prev = max(season_games.get(season - 1, 0), 1)
    else:
        prior_prev, n_prev = {}, 1
    run = 0
    for s in reversed(starters):
        if s == starters[-1]:
            run += 1
        else:
            break
    shares = {}
    for c in cands:
        shares[c] = prior.get(c, 0) / n_this if n_this >= 8 else prior_prev.get(c, 0) / n_prev * 0.7 + (prior.get(c, 0) / max(n_this, 1)) * 0.3
    top = max(shares.values()) if shares else 0.0
    out = []
    for c in cands:
        idxs = [i for i, s in enumerate(starters) if s == c]
        out.append((
            c,
            float(c == starters[-1]),
            sum(1 for s in starters[-3:] if s == c),
            sum(1 for s in starters[-5:] if s == c),
            sum(1 for s in starters[-10:] if s == c),
            len(idxs),
            (t - hist[idxs[-1]][0]).total_seconds() / 86400.0,
            b2b, rest_days, g7, shares[c], float(run if c == starters[-1] else 0), float(shares[c] >= top - 1e-9), float(len(cands)),
        ))
    return out


def candidate_rows(tg: pd.DataFrame) -> pd.DataFrame:
    """For every team-game, one row per candidate goalie with the features above and whether he actually started."""
    rows = []
    for team, d in tg.groupby("team", sort=False):
        d = d.sort_values(["t", "game_id"])
        hist: deque = deque(maxlen=WINDOW)  # (t, starter)
        season_starts: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
        season_games: dict[int, int] = defaultdict(int)
        for r in d.itertuples():
            for c, *feats in _feature_rows(hist, season_starts, season_games, r.t, r.season):
                rows.append((r.game_id, team, r.season, r.t, c, int(c == r.starter), *feats))
            hist.append((r.t, r.starter))
            season_starts[r.season][r.starter] += 1
            season_games[r.season] += 1
    cols = ["game_id", "team", "season", "t", "goalie", "y"] + FEATURES
    return pd.DataFrame(rows, columns=cols)


class UsageModel:
    """Fitted on all completed games; `probabilities` prices the next game for a team."""

    def __init__(self, tg: pd.DataFrame | None = None):
        self.tg = team_game_table() if tg is None else tg
        self.model = fit(candidate_rows(self.tg))
        self.by_team = {team: d.sort_values(["t", "game_id"]) for team, d in self.tg.groupby("team")}

    def probabilities(self, team_id: int, start: pd.Timestamp, top: int = 3, floor: float = 0.04) -> list[tuple[int, float]]:
        """[(goalie_id, P(starts))] for the most likely starters, renormalised to sum to 1. Empty if there's no history."""
        d = self.by_team.get(team_id)
        if d is None:
            return []
        start = pd.Timestamp(start)
        if start.tzinfo is None:
            start = start.tz_localize("UTC")
        hist: deque = deque(maxlen=WINDOW)
        season_starts: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
        season_games: dict[int, int] = defaultdict(int)
        for r in d[d["t"] < start].itertuples():
            hist.append((r.t, r.starter))
            season_starts[r.season][r.starter] += 1
            season_games[r.season] += 1
        season = start.year if start.month >= 9 else start.year - 1
        rows = _feature_rows(hist, season_starts, season_games, start, season)
        if not rows:
            return []
        X = pd.DataFrame([r[1:] for r in rows], columns=FEATURES)
        p = self.model.predict_proba(X)[:, 1]
        p = p / p.sum()
        ranked = sorted(zip((int(r[0]) for r in rows), p), key=lambda kv: -kv[1])[:top]
        kept = [(g, q) for g, q in ranked if q >= floor] or ranked[:1]
        tot = sum(q for _, q in kept)
        return [(g, q / tot) for g, q in kept]


def _normalise(df: pd.DataFrame, p: np.ndarray) -> np.ndarray:
    s = pd.Series(p, index=df.index)
    return (s / s.groupby([df["game_id"], df["team"]]).transform("sum")).to_numpy()


def fit(rows: pd.DataFrame) -> HistGradientBoostingClassifier:
    m = HistGradientBoostingClassifier(max_iter=160, learning_rate=0.06, max_depth=4, l2_regularization=1.0, random_state=0)
    m.fit(rows[FEATURES], rows["y"])
    return m


def heuristic(rows: pd.DataFrame) -> np.ndarray:
    """The old rule: the most-used goalie in the window 75%, the next 25% (a back-to-back's last starter is down-weighted
    the way publish.py did)."""
    out = np.zeros(len(rows))
    w = rows["starts_last10"].to_numpy(dtype=float)
    w = np.where((rows["started_last"] == 1) & (rows["b2b"] == 1), w * 0.3, w)
    tmp = rows.assign(w=w)
    for _, idx in tmp.groupby(["game_id", "team"]).groups.items():
        sub = tmp.loc[idx].sort_values("w", ascending=False)
        top2 = sub.index[:2]
        if len(top2) == 1:
            out[rows.index.get_indexer(top2)] = 1.0
        else:
            out[rows.index.get_indexer(top2[:1])] = 0.75
            out[rows.index.get_indexer(top2[1:2])] = 0.25
    return out


def evaluate(rows: pd.DataFrame) -> pd.DataFrame:
    """Walk-forward by season: log loss of the probability given to the goalie who actually started."""
    res = []
    for season in sorted(rows["season"].unique()):
        if season < 2018:
            continue
        tr, te = rows[rows["season"] < season], rows[rows["season"] == season].copy()
        if len(te) == 0:
            continue
        m = fit(tr)
        te["p_model"] = _normalise(te, m.predict_proba(te[FEATURES])[:, 1])
        te["p_rule"] = heuristic(te)
        for name in ("p_model", "p_rule"):
            te[name] = te[name].clip(lower=0.02)  # nobody is "impossible"
            te[name] = _normalise(te, te[name].to_numpy())
        res.append(te)
    te = pd.concat(res)
    act = te[te["y"] == 1]
    out = {}
    for name in ("p_model", "p_rule"):
        out[name] = {
            "log loss": float(-np.log(act[name]).mean()),
            "top-1 hit": float(te.loc[te.groupby(["game_id", "team"])[name].idxmax()]["y"].mean()),
            "avg prob given to the actual starter": float(act[name].mean()),
        }
    cover = act.shape[0] / te.groupby(["game_id", "team"]).ngroups
    print(f"candidate coverage: the starter was in the last-{WINDOW} window {cover:.1%} of the time")
    b = te.assign(b2b=te["b2b"].astype(bool))
    for flag, g in b[b["y"] == 1].groupby("b2b"):
        print(f"  back-to-back={flag}: n={len(g)}  model log loss {-np.log(g['p_model']).mean():.3f}  rule {-np.log(g['p_rule']).mean():.3f}  avg p(actual): model {g['p_model'].mean():.3f}, rule {g['p_rule'].mean():.3f}")
    # calibration of the model's probabilities
    te["bin"] = pd.cut(te["p_model"], [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0])
    cal = te.groupby("bin", observed=True).agg(n=("y", "size"), predicted=("p_model", "mean"), actual=("y", "mean"))
    print("\ncalibration of P(starts):")
    print(cal.round(3).to_string())
    return pd.DataFrame(out).T


def main() -> None:
    tg = team_game_table()
    rows = candidate_rows(tg)
    print(f"{len(rows):,} candidate rows over {rows.groupby(['game_id', 'team']).ngroups:,} team-games")
    print(evaluate(rows).round(4).to_string())


if __name__ == "__main__":
    main()
