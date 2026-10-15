"""
Line-movement model: predict where the closing line will be from information available at the OPEN.

Betting the opener only has an edge if the close is, on average, better than the open - and the opener is stale in ways that are
partly predictable: it is set before injury/lineup news and off ratings that lag, and it settles toward the market's consensus.
This model learns, from past games, how the number moves from open to close given:
  - where OUR projection sits relative to the open (spread and total),
  - the market structure of the game (open spread/total level),
  - how each team has been doing against the market lately (does the market under/over-rate them?),
  - context (rest, neutral site, conference game, early season, calendar).

Targets: spread_move = close - open (home margin), total_move = close - open. A bet "at the open" on the side the model
expects the line to move toward has positive closing-line value (CLV) when the model is right on average.

Usage:
    python -m cbb_model.movement build      # walk-forward projections + features for every game with an open and close line
    python -m cbb_model.movement evaluate   # strict walk-forward test: train on earlier seasons only, report CLV / win rate / ROI
    python -m cbb_model.movement train      # fit on all seasons and save movement_model.pkl
"""
from __future__ import annotations

import argparse
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .ingest import DATA_DIR
from .parse import CLOSING_ODDS_OUT, TEAM_GAMES_OUT

DATASET = DATA_DIR / "movement_dataset.pkl"
MODEL = DATA_DIR / "movement_model.pkl"

FEATURES = [
    "gap_s", "gap_t", "mo", "abs_mo", "total_open", "spread", "poss", "neutral", "conf_game", "early", "n_h", "n_a", "month", "dow",
    "rest_h", "rest_a", "rest_diff", "f5_m_h", "f5_m_a", "f10_m_h", "f10_m_a", "f5_t_h", "f5_t_a", "f10_t_h", "f10_t_a", "form_diff_m", "form_sum_t",
]


def team_form(tg: pd.DataFrame, odds: pd.DataFrame) -> pd.DataFrame:
    """Per game: each side's recent results against the market (actual minus closing margin / total) and rest days. Only games
    played BEFORE the one in question feed its row, so these are known at the open."""
    ge = odds.drop_duplicates("event_id").set_index("event_id")
    t = tg[tg["event_id"].isin(ge.index)].copy()
    mk_home = -ge.loc[t["event_id"], "spread_home_close"].to_numpy()
    t["mkt_margin"] = np.where(t["is_home"] == 1, mk_home, -mk_home)
    t["mkt_total"] = ge.loc[t["event_id"], "total_close"].to_numpy()
    t["res_m"] = (t["pts"] - t["opp_pts"]) - t["mkt_margin"]
    t["res_t"] = (t["pts"] + t["opp_pts"]) - t["mkt_total"]
    t = t.sort_values(["team_id", "start_utc"]).reset_index(drop=True)
    g = t.groupby(["team_id", "season"])
    for k in (5, 10):
        t[f"f{k}_m"] = g["res_m"].transform(lambda s, k=k: s.shift(1).rolling(k, min_periods=3).mean())
        t[f"f{k}_t"] = g["res_t"].transform(lambda s, k=k: s.shift(1).rolling(k, min_periods=3).mean())
    t["rest"] = ((t["start_utc"] - t.groupby("team_id")["start_utc"].shift(1)).dt.total_seconds() / 86400.0).clip(upper=14).fillna(14)
    cols = ["f5_m", "f10_m", "f5_t", "f10_t", "rest"]
    h = t[t["is_home"] == 1][["event_id"] + cols].rename(columns={c: f"{c}_h" for c in cols})
    a = t[t["is_home"] == 0][["event_id"] + cols].rename(columns={c: f"{c}_a" for c in cols})
    return h.merge(a, on="event_id", how="outer")


def add_features(m: pd.DataFrame) -> pd.DataFrame:
    """m needs: event_id, start_utc, spread, total, poss, n_h, n_a, neutral, conf_game, mo (open home margin), total_open + form cols."""
    m = m.copy()
    m["gap_s"] = m["spread"] - m["mo"]
    m["gap_t"] = m["total"] - m["total_open"]
    m["abs_mo"] = m["mo"].abs()
    m["month"] = m["start_utc"].dt.month
    m["dow"] = m["start_utc"].dt.dayofweek
    m["early"] = ((m["n_h"] < 8) | (m["n_a"] < 8)).astype(float)
    m["form_diff_m"] = m["f10_m_h"] - m["f10_m_a"]
    m["form_sum_t"] = m["f10_t_h"] + m["f10_t_a"]
    m["rest_diff"] = m["rest_h"] - m["rest_a"]
    return m


def build(first: int = 2022, last: int = 2025) -> pd.DataFrame:
    from .bpm import PLAYER_SEASONS_OUT, TARGETS_OUT, per40
    from .preseason import preseason_ratings
    from .inseason import CONFIG  # the exact setting the live ratings job uses, so training and live features match
    from .ratings import load, walk_forward

    ps40, tgt = per40(pd.read_csv(PLAYER_SEASONS_OUT)), pd.read_csv(TARGETS_OUT)
    tg = load()
    odds = pd.read_csv(CLOSING_ODDS_OUT)
    pred = walk_forward(tg, CONFIG, list(range(first, last + 1)), prior_provider=lambda s: preseason_ratings(s, ps40, tgt))
    g = tg[tg["is_home"] == 1][["event_id", "neutral", "conf_game"]].drop_duplicates("event_id")
    o = odds.drop_duplicates("event_id")[["event_id", "total_open", "spread_home_open", "total_close", "spread_home_close"]]
    m = pred.drop(columns=["neutral"], errors="ignore").merge(g, on="event_id", how="left").merge(o, on="event_id", how="left")
    m = m.dropna(subset=["total_open", "spread_home_open", "total_close", "spread_home_close"]).copy()
    m["start_utc"] = pd.to_datetime(m["start_utc"], utc=True)
    m["mo"], m["mc"] = -m["spread_home_open"], -m["spread_home_close"]
    m["mv_s"] = m["mc"] - m["mo"]
    m["mv_t"] = m["total_close"] - m["total_open"]
    tg2 = pd.read_csv(TEAM_GAMES_OUT)
    tg2["start_utc"] = pd.to_datetime(tg2["start_utc"], utc=True)
    m = m.merge(team_form(tg2, odds), on="event_id", how="left")
    m = add_features(m).reset_index(drop=True)
    m.to_pickle(DATASET)
    print(f"{len(m):,} games with open+close lines, seasons {sorted(m['season'].unique())} -> {DATASET}")
    return m


def _gb() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=250, l2_regularization=5.0, min_samples_leaf=80, random_state=0)


def bet_table(g: pd.DataFrame, p: np.ndarray, kind: str) -> list[str]:
    out = []
    g = g.assign(p=p)
    for frac in (0.5, 0.2, 0.1):
        s = g[g["p"].abs() >= g["p"].abs().quantile(1 - frac)]
        if kind == "spread":
            up = s["p"] > 0
            d = s["actual_margin"] + s["spread_home_open"]
            win, clv = np.where(up, d > 0, d < 0), np.where(up, s["mv_s"], -s["mv_s"])
        else:
            up = s["p"] > 0
            d = s["actual_total"] - s["total_open"]
            win, clv = np.where(up, d > 0, d < 0), np.where(up, s["mv_t"], -s["mv_t"])
        push = (d == 0).to_numpy()
        n = int((~push).sum())
        w = int(win[~push].sum())
        out.append(f"top {int(frac * 100):>2}%: n={n:>4} win {w / n * 100:.1f}% ROI {(w * 100 / 110 - (n - w)) / n * 100:+.1f}% CLV {clv.mean():+.2f}")
    return out


def evaluate() -> None:
    m = pd.read_pickle(DATASET)
    seasons = sorted(m["season"].unique())
    for season in seasons[1:]:
        tr, te = (m["season"] < season).to_numpy(), (m["season"] == season).to_numpy()
        for target, kind in (("mv_s", "spread"), ("mv_t", "total")):
            gb = _gb().fit(m.loc[tr, FEATURES].astype(float), m.loc[tr, target])
            p = gb.predict(m.loc[te, FEATURES].astype(float))
            y = m.loc[te, target].to_numpy()
            r2 = 1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)
            print(f"{season} {kind:<6} train {[int(s) for s in sorted(m.season[tr].unique())]} R2 {r2:+.3f} | " + " | ".join(bet_table(m.loc[te], p, kind)))


def train() -> None:
    m = pd.read_pickle(DATASET)
    models = {}
    for target in ("mv_s", "mv_t"):
        models[target] = _gb().fit(m[FEATURES].astype(float), m[target])
    with open(MODEL, "wb") as f:
        pickle.dump({"features": FEATURES, "models": models, "seasons": sorted(int(s) for s in m["season"].unique()), "n": len(m)}, f)
    print(f"trained on {len(m):,} games -> {MODEL}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["build", "evaluate", "train"])
    a = ap.parse_args()
    {"build": build, "evaluate": evaluate, "train": train}[a.what]()


if __name__ == "__main__":
    main()
