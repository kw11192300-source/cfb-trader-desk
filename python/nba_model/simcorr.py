"""
How player stats move together (a player who scores a lot in a game tends to also rebound and assist more: more minutes, more
possessions). The single-stat models give each stat's distribution on its own; to get double-double / triple-double chances the live
job draws the stats jointly through a Gaussian copula, with the correlations estimated here from history:

  for every played game, each stat's randomized probability-integral transform under the calibrated outcome tables (props.Dist),
  turned into a normal score; the correlation matrix of those scores is the copula.

    python -m nba_model.simcorr          # writes models/nba_stat_corr.json
"""
from __future__ import annotations

import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

from .live import MODELS, XCOLS
from .live_run import _Unpickler
from .minutes import FEATURES_OUT
from .props import feature_frame, target_values

STATS = ["pts", "reb", "ast", "tpm", "stl", "blk", "tov"]


def main() -> None:
    df = pd.read_csv(FEATURES_OUT)
    df = df[(df["played"] == 1) & df["rs_pts"].notna()].reset_index(drop=True)
    with open(MODELS / "nba_minutes_model.pkl", "rb") as f:
        mb = _Unpickler(f).load()
    with open(MODELS / "nba_props_models.pkl", "rb") as f:
        pb = _Unpickler(f).load()
    for col, key in (("pm_mean", "mean"), ("pm_q10", "q10"), ("pm_q50", "q50"), ("pm_q90", "q90")):
        df[col] = mb["models"][key].predict(df[XCOLS])
    rng = np.random.default_rng(1)
    z = {}
    for name in STATS:
        X = feature_frame(df, pb["targets"][name], name)
        mu = pb["models"][name].predict(X)
        y = target_values(df, pb["targets"][name]).to_numpy().astype(int)
        d = pb["dists"][name]
        hi = np.clip(y, 0, len(d.vals) - 1)
        lo = np.clip(y - 1, -1, len(d.vals) - 1)
        c_hi = d.cdf_at(mu, hi)
        c_lo = np.where(y <= 0, 0.0, d.cdf_at(mu, np.maximum(lo, 0)))
        u = c_lo + rng.random(len(y)) * (c_hi - c_lo)
        z[name] = norm.ppf(np.clip(u, 1e-4, 1 - 1e-4))
    Z = pd.DataFrame(z)
    corr = Z.corr().to_numpy()
    print(Z.corr().round(2).to_string())
    (Path(MODELS) / "nba_stat_corr.json").write_text(json.dumps({"stats": STATS, "corr": corr.tolist(), "rows": int(len(Z))}, indent=1))
    print(f"{len(Z):,} player-games -> models/nba_stat_corr.json")


if __name__ == "__main__":
    main()
