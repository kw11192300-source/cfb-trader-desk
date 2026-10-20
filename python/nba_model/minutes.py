"""
Projected minutes for every player in every game - the input the bottom-up model needs.

Minutes are modelled GIVEN that the player plays; whether he plays comes from the injury report (calibrated separately). The model
learns, from 172k player-games, how a player's minutes depend on
  - his own recent minutes (several decays: last game, last 5, a fast and a slow moving average, the season so far),
  - his role (starter rate over recent games),
  - who ELSE is playing: the minutes "vacated" by rotation teammates who are out, and how many rotation players are available,
  - rest (back-to-back, days off) and home/away,
  - blowout risk: the expected margin (closing spread when we have it, otherwise a team-strength estimate).
Every feature uses only games BEFORE the one being predicted.

    python -m nba_model.minutes build        # build the feature table (data/nba/minutes_features.parquet-style csv.gz)
    python -m nba_model.minutes evaluate     # train 2021-24, test 2025: MAE vs simple baselines, quantile coverage
    python -m nba_model.minutes train        # fit on everything, save data/nba/minutes_model.pkl
"""
from __future__ import annotations

import argparse
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .ingest import DATA_DIR
from .parse import GAMES_OUT, ODDS_OUT, PLAYER_GAMES_OUT

FEATURES_OUT = DATA_DIR / "minutes_features.csv.gz"
MODEL_OUT = DATA_DIR / "minutes_model.pkl"

A_FAST, A_SLOW = 0.35, 0.10
COLD = 12.0  # minutes assumed for a player with no history yet


def build() -> pd.DataFrame:
    gm = pd.read_csv(GAMES_OUT)
    gm["start_utc"] = pd.to_datetime(gm["start_utc"], utc=True)
    pg = pd.read_csv(PLAYER_GAMES_OUT)
    pg["start_utc"] = pd.to_datetime(pg["start_utc"], utc=True)
    pg = pg[pg["player_id"].notna()].copy()
    pg["player_id"] = pg["player_id"].astype("int64")
    od = pd.read_csv(ODDS_OUT) if ODDS_OUT.exists() else pd.DataFrame(columns=["event_id", "spread_home_close"])
    gm = gm.merge(od[["event_id", "spread_home_close"]], on="event_id", how="left").sort_values("start_utc").reset_index(drop=True)
    by_event = {e: g for e, g in pg.groupby("event_id")}

    # team strength (margin EWMA, carried across seasons) for the blowout feature when there is no closing line
    strength: dict[int, float] = {}
    pstate: dict[int, dict] = {}  # player -> baselines (carried across seasons and teams)
    last_game: dict[int, pd.Timestamp] = {}  # team -> last game time
    team_hist: dict[int, list] = {}  # team -> recent game times for schedule density
    pool_by_season: dict[tuple, dict] = {}  # (season, team) -> {player: (first_time, last_time)} listed window
    for (s, t), g in pg.groupby(["season", "team_id"]):
        w = g.groupby("player_id")["start_utc"].agg(["min", "max"])
        pool_by_season[(int(s), int(t))] = {int(p): (r["min"], r["max"]) for p, r in w.iterrows()}

    rows = []
    for gi in gm.itertuples():
        box = by_event.get(gi.event_id)
        if box is None:
            continue
        exp_margin_proxy = strength.get(gi.home_id, 0.0) - strength.get(gi.away_id, 0.0) + 2.5
        spr = -gi.spread_home_close if pd.notna(gi.spread_home_close) else exp_margin_proxy
        for team, opp, is_home in ((gi.home_id, gi.away_id, 1), (gi.away_id, gi.home_id, 0)):
            tb = box[box["team_id"] == team]
            played = {int(p): float(m) for p, m in zip(tb["player_id"], tb["min"]) if m > 0}
            started = {int(p) for p, st in zip(tb["player_id"], tb["starter"]) if st}
            pool = pool_by_season.get((int(gi.season), int(team)), {})
            members = [p for p, (a, b) in pool.items() if a <= gi.start_utc <= b]
            members = list(set(members) | set(played))
            rest = (gi.start_utc - last_game[team]).total_seconds() / 86400.0 if team in last_game else 7.0
            recent = [x for x in team_hist.get(team, []) if (gi.start_utc - x).total_seconds() <= 4 * 86400.0]
            sign = 1.0 if is_home else -1.0
            exp_margin = sign * spr  # + = this team favoured
            base = {p: pstate[p]["slow"] if p in pstate else COLD for p in members}
            vacated = sum(base[p] for p in members if p not in played and base[p] >= 8.0)
            avail_rot = sum(1 for p in played if base.get(p, COLD) >= 8.0)
            n_out_rot = sum(1 for p in members if p not in played and base[p] >= 8.0)
            for p in members:
                st = pstate.get(p)
                pm = played.get(p, 0.0)
                if st is None:
                    feats = {"fast": COLD, "slow": COLD, "last": COLD, "last5": COLD, "season_mean": COLD, "start_rate": 0.0, "n_prior": 0, "gap_games": 0}
                else:
                    l5 = st["recent"][-5:]
                    feats = {"fast": st["fast"], "slow": st["slow"], "last": st["recent"][-1], "last5": float(np.mean(l5)), "season_mean": st["season_sum"] / max(st["season_n"], 1) if st["season"] == gi.season else st["slow"],
                             "start_rate": st["start"], "n_prior": st["n"], "gap_games": int(st["team_games_since"])}
                # rank of this player's baseline among this team's players available TODAY
                avail_bases = sorted([base[q] for q in played if q != p], reverse=True)
                rank = 1 + sum(1 for b in avail_bases if b > base[p])
                rows.append(
                    {
                        "event_id": gi.event_id, "season": gi.season, "start_utc": gi.start_utc, "team_id": team, "player_id": p, "is_home": is_home,
                        "played": 1 if p in played else 0, "min": pm, "started": 1 if p in started else 0,
                        **feats, "vacated": vacated - (base[p] if (p not in played and base[p] >= 8.0) else 0.0), "avail_rot": avail_rot, "n_out_rot": n_out_rot, "rank_today": rank,
                        "rest": rest, "b2b": 1 if rest < 1.5 else 0, "games_4d": len(recent), "exp_margin": exp_margin, "abs_margin": abs(exp_margin),
                    }
                )
        # update states AFTER the game, for everyone who played
        for team in (gi.home_id, gi.away_id):
            tb = box[box["team_id"] == team]
            playing = {int(p): (float(m), bool(st)) for p, m, st in zip(tb["player_id"], tb["min"], tb["starter"]) if m > 0}
            for p in list(pstate):
                pass
            for p, (m, st) in playing.items():
                s_ = pstate.get(p)
                if s_ is None:
                    s_ = {"fast": m, "slow": m, "recent": [], "start": 0.0, "n": 0, "season": gi.season, "season_sum": 0.0, "season_n": 0, "team_games_since": 0}
                    pstate[p] = s_
                    s_["fast"] = s_["slow"] = COLD * 0.5 + m * 0.5
                else:
                    s_["fast"] = A_FAST * m + (1 - A_FAST) * s_["fast"]
                    s_["slow"] = A_SLOW * m + (1 - A_SLOW) * s_["slow"]
                if s_["season"] != gi.season:
                    s_["season"], s_["season_sum"], s_["season_n"] = gi.season, 0.0, 0
                s_["season_sum"] += m
                s_["season_n"] += 1
                s_["recent"].append(m)
                s_["recent"] = s_["recent"][-10:]
                s_["start"] = 0.8 * s_["start"] + 0.2 * (1.0 if st else 0.0)
                s_["n"] += 1
                s_["team_games_since"] = 0
            # players of this team who did not play this game: their "games since" ticks up
            for p, (a, b) in pool_by_season.get((int(gi.season), int(team)), {}).items():
                if p in pstate and p not in playing and a <= gi.start_utc <= b:
                    pstate[p]["team_games_since"] += 1
            last_game[team] = gi.start_utc
            th = team_hist.setdefault(team, [])
            th.append(gi.start_utc)
            if len(th) > 6:
                del th[0]
        margin = gi.home_pts - gi.away_pts
        for tm, mg in ((gi.home_id, margin), (gi.away_id, -margin)):
            strength[tm] = 0.9 * strength.get(tm, 0.0) + 0.1 * mg
    df = pd.DataFrame(rows)
    df.to_csv(FEATURES_OUT, index=False)
    print(f"{len(df):,} player-game rows ({int(df.played.sum()):,} played) -> {FEATURES_OUT}")
    return df


XCOLS = ["fast", "slow", "last", "last5", "season_mean", "start_rate", "n_prior", "gap_games", "vacated", "avail_rot", "n_out_rot", "rank_today", "rest", "b2b", "games_4d", "exp_margin", "abs_margin", "is_home"]


def _gb(loss="squared_error", q=None) -> HistGradientBoostingRegressor:
    kw = {"quantile": q} if q is not None else {}
    return HistGradientBoostingRegressor(loss=loss, max_depth=5, learning_rate=0.06, max_iter=350, l2_regularization=2.0, min_samples_leaf=120, random_state=0, **kw)


def evaluate() -> None:
    df = pd.read_csv(FEATURES_OUT)
    df = df[df["played"] == 1]
    last = int(df["season"].max())
    tr, te = df[df["season"] < last], df[df["season"] == last]
    print(f"train {len(tr):,} played rows (seasons < {last}), test {len(te):,} ({last})")
    y = te["min"].to_numpy()
    mae = lambda p: float(np.mean(np.abs(y - p)))  # noqa: E731
    print(f"baselines: slow average {mae(te['slow']):.2f} | fast {mae(te['fast']):.2f} | last-5 average {mae(te['last5']):.2f} | season mean {mae(te['season_mean']):.2f}")
    m = _gb().fit(tr[XCOLS], tr["min"])
    p = m.predict(te[XCOLS])
    print(f"model (squared error): MAE {mae(p):.2f} | RMSE {float(np.sqrt(np.mean((y - p) ** 2))):.2f}")
    for lab, lo, hi in (("starters (baseline >= 28)", 28, 99), ("rotation (15-28)", 15, 28), ("bench (< 15)", 0, 15)):
        s = ((te["slow"] >= lo) & (te["slow"] < hi)).to_numpy()
        print(f"  {lab:<26} n={s.sum():>6}: model MAE {np.mean(np.abs(y[s] - p[s])):.2f} vs slow-average {np.mean(np.abs(y[s] - te['slow'].to_numpy()[s])):.2f}")
    # does vacated-minutes redistribution work? players whose team had >= 20 vacated minutes
    v = (te["vacated"] >= 20).to_numpy()
    print(f"  when rotation teammates are out (vacated >= 20 min, n={v.sum()}): model {np.mean(np.abs(y[v] - p[v])):.2f} vs slow {np.mean(np.abs(y[v] - te['slow'].to_numpy()[v])):.2f} | mean actual - slow = {np.mean(y[v] - te['slow'].to_numpy()[v]):+.2f}, model mean shift {np.mean(p[v] - te['slow'].to_numpy()[v]):+.2f}")
    for q in (0.1, 0.5, 0.9):
        mq = _gb("quantile", q).fit(tr[XCOLS], tr["min"])
        pq = mq.predict(te[XCOLS])
        print(f"  quantile {q:.1f}: share of actual minutes below the prediction {np.mean(y <= pq) * 100:.1f}% (ideal {q * 100:.0f}%)")


def train() -> None:
    df = pd.read_csv(FEATURES_OUT)
    df = df[df["played"] == 1]
    models = {"mean": _gb().fit(df[XCOLS], df["min"])}
    for q in (0.1, 0.5, 0.9):
        models[f"q{int(q * 100)}"] = _gb("quantile", q).fit(df[XCOLS], df["min"])
    with open(MODEL_OUT, "wb") as f:
        pickle.dump({"features": XCOLS, "models": models, "rows": len(df)}, f)
    print(f"trained on {len(df):,} rows -> {MODEL_OUT}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["build", "evaluate", "train"])
    a = ap.parse_args()
    {"build": build, "evaluate": evaluate, "train": train}[a.what]()


if __name__ == "__main__":
    main()
