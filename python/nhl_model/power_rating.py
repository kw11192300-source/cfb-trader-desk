"""
One team power rating that folds the team stats together.

Rating = the goal differential per game we expect a team to post over the REST of the season (vs an average
team), predicted from everything we measure about it so far:

    even-strength xG differential   (score-adjusted, per game)
    special-teams xG differential   (power play + penalty kill, score-adjusted, per game)
    goaltending vs expected         (xG against minus goals against, per game)
    finishing vs expected           (goals for minus xG for, per game)
    last season's xG differential   (carried in, and trusted less as the new season fills up)

The weights are NOT guessed: a ridge regression learns them from history, by predicting each team's goal
differential over its remaining games from its stats after 5, 10, 15 ... 70 games. Stats from a short sample
are shrunk (n / (n + 20) of their face value, the rest handed to last season's number), which is what makes an
October rating sensible. The rating is a sum of weight x stat, so each team's rating splits cleanly into
even strength / special teams / goaltending / finishing / carry-over pieces.

Validation is walk-forward by season (each season is predicted from a model trained only on earlier ones) and
compared against the obvious single measures - see validate().

    python -m nhl_model.power_rating      # prints the validation + the current table
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

K_REL = 20.0  # games of evidence at which a stat counts half
CHECKPOINTS = list(range(5, 75, 5))
MIN_REMAINING = 10
RIDGE_ALPHA = 1.0
FEATURES = ["ev", "st", "goalie", "finish", "prior"]
LABELS = {"ev": "Even strength", "st": "Special teams", "goalie": "Goaltending", "finish": "Finishing", "prior": "Last season"}


def _team_game_features(tg: pd.DataFrame) -> pd.DataFrame:
    d = tg.sort_values(["season", "team_id", "t"]).copy()
    d["ev_d"] = d["xgf_adj_ev"] - d["xga_adj_ev"]
    d["st_d"] = d["xgf_adj_st"] - d["xga_adj_st"]
    d["goalie_d"] = d["xga"] - d["ga"]
    d["finish_d"] = d["gf"] - d["xgf"]
    d["gd"] = d["gf"] - d["ga"]
    d["pts_c"] = d["pts"]
    d["n"] = d.groupby(["season", "team_id"]).cumcount() + 1
    d["gp_total"] = d.groupby(["season", "team_id"])["n"].transform("max")
    cols = ["ev_d", "st_d", "goalie_d", "finish_d", "gd", "pts_c", "xgf", "xga"]
    cum = d.groupby(["season", "team_id"])[cols].cumsum()
    for c in cols:
        d[c + "_cum"] = cum[c]
    return d


def _rows(d: pd.DataFrame, at: str) -> pd.DataFrame:
    """At each team-season checkpoint: per-game stats so far, last season's full-year xG differential, and the
    goal differential per game over the remaining games (the target)."""
    final = d[d["n"] == d["gp_total"]].set_index(["season", "team_id"])
    prior = ((final["ev_d_cum"] + final["st_d_cum"]) / final["gp_total"]).rename("prior_raw")
    prior.index = pd.MultiIndex.from_arrays([prior.index.get_level_values(0) + 1, prior.index.get_level_values(1)])
    gd_final = final["gd_cum"].rename("gd_final")

    if at == "checkpoints":
        r = d[d["n"].isin(CHECKPOINTS)].copy()
    else:  # the latest point for every team-season
        r = d[d["n"] == d["gp_total"]].copy()
    r = r.join(prior, on=["season", "team_id"]).join(gd_final, on=["season", "team_id"])
    r["prior_raw"] = r["prior_raw"].fillna(0.0)
    n = r["n"].to_numpy(dtype=float)
    r["rel"] = n / (n + K_REL)
    r["x_ev"] = r["rel"] * r["ev_d_cum"] / n
    r["x_st"] = r["rel"] * r["st_d_cum"] / n
    r["x_goalie"] = r["rel"] * r["goalie_d_cum"] / n
    r["x_finish"] = r["rel"] * r["finish_d_cum"] / n
    r["x_prior"] = (1 - r["rel"]) * r["prior_raw"]
    rem = r["gp_total"] - r["n"]
    r["rem"] = rem
    r["y"] = np.where(rem > 0, (r["gd_final"] - r["gd_cum"]) / rem.replace(0, np.nan), np.nan)
    return r


def _fit(train: pd.DataFrame) -> Ridge:
    t = train[train["rem"] >= MIN_REMAINING]
    m = Ridge(alpha=RIDGE_ALPHA, fit_intercept=False)
    m.fit(t[[f"x_{f}" for f in FEATURES]].to_numpy(), t["y"].to_numpy(), sample_weight=t["rem"].to_numpy())
    return m


BUCKETS = [(0, 12), (13, 27), (28, 42), (43, 200)]


def _bucket(n: float) -> int:
    return next(i for i, (a, b) in enumerate(BUCKETS) if a <= n <= b)


def _walk_forward(r: pd.DataFrame) -> pd.DataFrame:
    """Out-of-sample predictions for every checkpoint of every completed season from 2017 on."""
    out = []
    for season in sorted(r["season"].unique()):
        if season < 2017 or r.loc[r["season"] == season, "gp_total"].max() < 50:  # skip warm-up seasons and any season in progress
            continue
        m = _fit(r[r["season"] < season])
        te = r[(r["season"] == season) & (r["rem"] >= MIN_REMAINING)].copy()
        te["power"] = m.predict(te[[f"x_{f}" for f in FEATURES]].to_numpy())
        out.append(te)
    return pd.concat(out)


def calibration(r: pd.DataFrame) -> list[float]:
    """Out-of-sample slope of actual on predicted goal differential, per games-played bucket, capped at 1: a few games
    in, the rating is a little too spread out (a hot start is noisier than the weights assume), so it is scaled down."""
    te = _walk_forward(r)
    te["b"] = te["n"].map(_bucket)
    return [float(min(1.0, np.polyfit(g["power"], g["y"], 1)[0])) for _, g in te.groupby("b")]


def validate(d: pd.DataFrame) -> pd.DataFrame:
    """Walk-forward: each test season is scored by a model fitted on earlier seasons only."""
    te = _walk_forward(_rows(d, "checkpoints"))
    te["pts_pct"] = te["pts_c_cum"] / (2 * te["n"])
    te["gd_pg"] = te["gd_cum"] / te["n"]
    te["xgd_raw"] = (te["xgf_cum"] - te["xga_cum"]) / te["n"]
    te["xgd_sa"] = (te["ev_d_cum"] + te["st_d_cum"]) / te["n"]
    rows = []
    for n in (10, 20, 40, 60):
        g = te[te["n"] == n]
        row = {"games played": n, "team-seasons": len(g)}
        for name, col in (("POWER RATING", "power"), ("points %", "pts_pct"), ("goal diff/g", "gd_pg"), ("xG diff/g (raw)", "xgd_raw"), ("xG diff/g (score-adj)", "xgd_sa"), ("last season only", "prior_raw")):
            row[name] = np.corrcoef(g[col], g["y"])[0, 1]
        rows.append(row)
    return pd.DataFrame(rows).set_index("games played")


def rate(tg: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Final weights (fit on every completed season in the table) applied to every team-season as of its latest game.
    Returns (one row per team-season with the rating and its pieces, the weights)."""
    d = _team_game_features(tg[tg["xgf_adj_ev"].notna()])
    train = _rows(d, "checkpoints")
    m = _fit(train)
    now = _rows(d, "latest")
    cal = calibration(train)
    scale = np.array([cal[_bucket(n)] for n in now["n"]])
    X = now[[f"x_{f}" for f in FEATURES]].to_numpy()
    comp = X * m.coef_ * scale[:, None]
    out = now[["season", "team_id", "n", "rel"]].copy()
    out["calibration"] = scale
    out["power"] = comp.sum(axis=1)
    for i, f in enumerate(FEATURES):
        out[f"comp_{f}"] = comp[:, i]
    return out.reset_index(drop=True), pd.Series(m.coef_, index=FEATURES)


def main() -> None:
    from .team_stats import team_game_frame

    tg = team_game_frame()
    d = _team_game_features(tg[tg["xgf_adj_ev"].notna()])
    v = validate(d)
    print("Walk-forward correlation with goal differential over the REMAINING games (2017-2025 test seasons):")
    print(v.round(3).to_string())
    out, coef = rate(tg)
    print("\nLearned weights (goal-diff per game per 1 goal/game of the stat; 'prior' is on last season's xG diff):")
    print(coef.round(3).to_string())
    cur = out[out["season"] == out["season"].max()].sort_values("power", ascending=False)
    print(cur.head(10).round(3).to_string())


if __name__ == "__main__":
    main()
