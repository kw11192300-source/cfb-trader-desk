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
STATS = ["pts", "reb", "ast", "tpm", "stl", "blk", "tov", "fga", "fta"]  # stats whose per-minute rates and team context feed the projections
R_FAST, R_SLOW = 0.25, 0.07
R_LONG = 0.025  # a ~40-game memory: his real talent level, so a cold or hot stretch (or an injured playoff run) does not set his projection
A_TEAM = 0.10
COLD = 12.0  # minutes assumed for a player with no history yet


def build(emit: bool = True, stop_at: int | None = None, regular_only: bool = True):
    """The feature table (emit=True, written to FEATURES_OUT) or, with emit=False, just the rolling state after the last game before
    `stop_at` (or after every game): what the live projections start from. The state carries every player's minutes / rate baselines.
    Postseason games (season_type 3) are left out of both the rows and the state by default: playoff minutes, rotations, pace and
    scoring are a different game from the regular season, and an injured star's playoff stretch should not set his October projection."""
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

    tgcount: dict[tuple, int] = {}  # (team, season) -> games played so far
    allowed: dict[int, dict] = {}  # team -> EWMA of what its opponents produced per game (defence context)
    pace: dict[int, float] = {}
    rows = []
    for gi in gm.itertuples():
        if stop_at is not None and gi.event_id == stop_at:
            break
        if regular_only and getattr(gi, "season_type", 2) == 3:
            continue
        box = by_event.get(gi.event_id)
        if box is None:
            continue
        stat_of = {(int(t), int(p)): {k: float(v) for k, v in zip(STATS, vals)} for t, p, vals in zip(box['team_id'], box['player_id'], box[STATS].to_numpy())}
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
            vac_stats = {k: sum(pstate[p]["rs"][k] for p in members if p not in played and p in pstate and base[p] >= 8.0) for k in ("pts", "reb", "ast", "tpm", "fga")}
            if not emit:
                continue
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
                rates = {}
                for k in STATS:
                    if st is None:
                        rates[f"rf_{k}"] = rates[f"rs_{k}"] = rates[f"rsea_{k}"] = rates[f"rl_{k}"] = np.nan
                    else:
                        rates[f"rf_{k}"] = st["rf"][k] / max(st["rfm"], 1e-6)
                        rates[f"rs_{k}"] = st["rs"][k] / max(st["rsm"], 1e-6)
                        rates[f"rl_{k}"] = st["rl"][k] / max(st["rlm"], 1e-6)
                        rates[f"rsea_{k}"] = (st["ssum"][k] / max(st["smin"], 1e-6)) if st["season"] == gi.season and st["smin"] > 60 else rates[f"rs_{k}"]
                opp_a = allowed.get(opp, {})
                own_pace, opp_pace = pace.get(team), pace.get(opp)
                rows.append(
                    {
                        "event_id": gi.event_id, "season": gi.season, "start_utc": gi.start_utc, "team_id": team, "player_id": p, "is_home": is_home,
                        "played": 1 if p in played else 0, "min": pm, "started": 1 if p in started else 0,
                        **feats, "vacated": vacated - (base[p] if (p not in played and base[p] >= 8.0) else 0.0), "avail_rot": avail_rot, "n_out_rot": n_out_rot, "rank_today": rank,
                        "tgno": tgcount.get((int(team), int(gi.season)), 0) + 1, "rest": rest, "b2b": 1 if rest < 1.5 else 0, "games_4d": len(recent), "exp_margin": exp_margin, "abs_margin": abs(exp_margin),
                        **rates, **{f"vac_{k}": vac_stats[k] - (pstate[p]["rs"][k] if (p not in played and p in pstate and base[p] >= 8.0) else 0.0) for k in ("pts", "reb", "ast", "tpm", "fga")},
                        **{f"opp_{k}": opp_a.get(k, np.nan) for k in STATS}, "own_pace": own_pace if own_pace is not None else np.nan, "opp_pace": opp_pace if opp_pace is not None else np.nan,
                        **(stat_of.get((int(team), int(p))) or {k: np.nan for k in STATS}),
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
                    s_ = {"fast": m, "slow": m, "recent": [], "start": 0.0, "n": 0, "season": gi.season, "season_sum": 0.0, "season_n": 0, "team_games_since": 0,
                          "rf": {k: 0.0 for k in STATS}, "rs": {k: 0.0 for k in STATS}, "rfm": 0.0, "rsm": 0.0, "rl": {k: 0.0 for k in STATS}, "rlm": 0.0, "ssum": {k: 0.0 for k in STATS}, "smin": 0.0, "seen": False}
                    pstate[p] = s_
                    s_["fast"] = s_["slow"] = COLD * 0.5 + m * 0.5
                else:
                    s_["fast"] = A_FAST * m + (1 - A_FAST) * s_["fast"]
                    s_["slow"] = A_SLOW * m + (1 - A_SLOW) * s_["slow"]
                if s_["season"] != gi.season:
                    s_["season"], s_["season_sum"], s_["season_n"] = gi.season, 0.0, 0
                    s_["ssum"], s_["smin"] = {k: 0.0 for k in STATS}, 0.0
                sv = stat_of.get((int(team), int(p)), {})
                if not s_["seen"]:
                    s_["rf"] = {k: sv.get(k, 0.0) for k in STATS}
                    s_["rs"] = {k: sv.get(k, 0.0) for k in STATS}
                    s_["rl"] = {k: sv.get(k, 0.0) for k in STATS}
                    s_["rfm"] = s_["rsm"] = s_["rlm"] = m
                    s_["seen"] = True
                else:
                    for k in STATS:
                        s_["rf"][k] = R_FAST * sv.get(k, 0.0) + (1 - R_FAST) * s_["rf"][k]
                        s_["rs"][k] = R_SLOW * sv.get(k, 0.0) + (1 - R_SLOW) * s_["rs"][k]
                        s_["rl"][k] = R_LONG * sv.get(k, 0.0) + (1 - R_LONG) * s_["rl"][k]
                    s_["rlm"] = R_LONG * m + (1 - R_LONG) * s_["rlm"]
                    s_["rfm"] = R_FAST * m + (1 - R_FAST) * s_["rfm"]
                    s_["rsm"] = R_SLOW * m + (1 - R_SLOW) * s_["rsm"]
                for k in STATS:
                    s_["ssum"][k] += sv.get(k, 0.0)
                s_["smin"] += m
                s_["season_sum"] += m
                s_["season_n"] += 1
                s_["recent"].append(m)
                s_["recent"] = s_["recent"][-10:]
                s_["start"] = 0.8 * s_["start"] + 0.2 * (1.0 if st else 0.0)
                s_["n"] += 1
                s_["team_games_since"] = 0
                s_["team"], s_["last_t"] = int(team), gi.start_utc
            # players of this team who did not play this game: their "games since" ticks up
            for p, (a, b) in pool_by_season.get((int(gi.season), int(team)), {}).items():
                if p in pstate and p not in playing and a <= gi.start_utc <= b:
                    pstate[p]["team_games_since"] += 1
            last_game[team] = gi.start_utc
            tgcount[(int(team), int(gi.season))] = tgcount.get((int(team), int(gi.season)), 0) + 1
            th = team_hist.setdefault(team, [])
            th.append(gi.start_utc)
            if len(th) > 6:
                del th[0]
        for team, opp in ((gi.home_id, gi.away_id), (gi.away_id, gi.home_id)):
            ob = box[box['team_id'] == opp]
            produced = {k: float(ob[k].sum()) for k in STATS}  # what the OPPONENT produced against this team
            a = allowed.setdefault(team, dict(produced))
            for k in STATS:
                a[k] = A_TEAM * produced[k] + (1 - A_TEAM) * a[k]
            pace[team] = A_TEAM * float(gi.poss) + (1 - A_TEAM) * pace.get(team, float(gi.poss))
        margin = gi.home_pts - gi.away_pts
        for tm, mg in ((gi.home_id, margin), (gi.away_id, -margin)):
            strength[tm] = 0.9 * strength.get(tm, 0.0) + 0.1 * mg
    if not emit:
        return {"pstate": pstate, "last_game": last_game, "team_hist": team_hist, "allowed": allowed, "pace": pace, "strength": strength, "tgcount": tgcount}
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
    ap.add_argument("--with-playoffs", action="store_true", help="keep postseason games in the features (the old behaviour; for comparison)")
    a = ap.parse_args()
    if a.what == "build":
        build(regular_only=not a.with_playoffs)
    else:
        {"evaluate": evaluate, "train": train}[a.what]()


if __name__ == "__main__":
    main()
