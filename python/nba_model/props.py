"""
Player stat projections: for every player-game, a median and a full range for points, rebounds, assists, threes, steals, blocks,
turnovers and the combos (PR, PA, RA, PRA, steals+blocks) - conditional on the player playing (a prop is void if he doesn't).

Design: each stat gets quantile models (10/25/50/75/90) plus a mean model, trained on
  - the minutes model's PREDICTED minutes (mean, 10th, median, 90th) - so the stat spread already includes minutes uncertainty,
  - his per-minute rates (fast / slow / season-to-date moving averages),
  - the opponent's allowed production and both teams' pace,
  - the scoring / rebounding / assist production of teammates who are out (the usage that gets redistributed),
  - home/away, rest, blowout risk.
Minutes for training rows come from leave-one-season-out forecasts, so a stat model never sees minutes from a model that saw its game.

    python -m nba_model.props evaluate     # train 2021-24, test 2025: MAE vs naive, quantile calibration
    python -m nba_model.props train        # all seasons -> data/nba/props_models.pkl
"""
from __future__ import annotations

import argparse
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .ingest import DATA_DIR
from .minutes import FEATURES_OUT, XCOLS, _gb as minutes_gb

MODELS_OUT = DATA_DIR / "props_models.pkl"
QUANTS = (0.1, 0.25, 0.5, 0.75, 0.9)
TARGETS: dict[str, list[str]] = {
    "pts": ["pts"], "reb": ["reb"], "ast": ["ast"], "tpm": ["tpm"], "stl": ["stl"], "blk": ["blk"], "tov": ["tov"],
    "pra": ["pts", "reb", "ast"], "pr": ["pts", "reb"], "pa": ["pts", "ast"], "ra": ["reb", "ast"], "stocks": ["stl", "blk"],
}
VAC = {"pts": "vac_pts", "reb": "vac_reb", "ast": "vac_ast", "tpm": "vac_tpm"}


def minutes_forecasts(df: pd.DataFrame, holdout: int | None) -> pd.DataFrame:
    """Predicted minutes (mean, q10, q50, q90) for every played row. Seasons are forecast by models trained on the OTHER seasons
    (never on `holdout`); the holdout season itself is forecast by a model trained on all the others."""
    played = df[df["played"] == 1]
    seasons = sorted(played["season"].unique())
    train_pool = [s for s in seasons if s != holdout]
    out = pd.DataFrame(index=played.index, columns=["pm_mean", "pm_q10", "pm_q50", "pm_q90"], dtype=float)
    specs = {"pm_mean": ("squared_error", None), "pm_q10": ("quantile", 0.1), "pm_q50": ("quantile", 0.5), "pm_q90": ("quantile", 0.9)}
    for s in seasons:
        others = [x for x in train_pool if x != s]
        tr = played[played["season"].isin(others)]
        te = played[played["season"] == s]
        for col, (loss, q) in specs.items():
            m = minutes_gb(loss, q).fit(tr[XCOLS], tr["min"])
            out.loc[te.index, col] = m.predict(te[XCOLS])
        print(f"  minutes forecast for {s} (trained on {others})", flush=True)
    return out


USE_LONG = False  # add the ~40-game per-minute rates (features_version 2)


def feature_frame(df: pd.DataFrame, comps: list[str], target: str, use_long: bool | None = None) -> pd.DataFrame:
    use_long = USE_LONG if use_long is None else use_long
    X = pd.DataFrame(index=df.index)
    for k in ("pm_mean", "pm_q10", "pm_q50", "pm_q90"):
        X[k] = df[k]
    for tag in ("rf", "rs", "rsea"):
        X[f"rate_{tag}"] = sum(df[f"{tag}_{c}"] for c in comps)
    if use_long:
        X["rate_rl"] = sum(df[f"rl_{c}"] for c in comps)
        X["exp_long"] = X["pm_mean"] * X["rate_rl"]
        X["tgno"] = df["tgno"].clip(upper=30)  # how far into the season: early on, stars outscore what last spring's rates say
    X["exp_slow"] = X["pm_mean"] * X["rate_rs"]
    X["exp_fast"] = X["pm_mean"] * X["rate_rf"]
    X["exp_sea"] = X["pm_mean"] * X["rate_rsea"]
    X["opp_allow"] = sum(df[f"opp_{c}"] for c in comps)
    vac_cols = [VAC[c] for c in comps if c in VAC]
    X["vac_stat"] = sum(df[v] for v in vac_cols) if vac_cols else df["vac_fga"]
    X["vac_fga"] = df["vac_fga"]
    X["exp_pace"] = (df["own_pace"] + df["opp_pace"]) / 2.0
    for c in ("vacated", "n_out_rot", "rank_today", "start_rate", "fast", "rest", "b2b", "abs_margin", "exp_margin", "is_home", "n_prior"):
        X[c] = df[c]
    return X


def target_values(df: pd.DataFrame, comps: list[str]) -> pd.Series:
    return sum(df[c] for c in comps)


def _q(q: float | None) -> HistGradientBoostingRegressor:
    kw = {"loss": "quantile", "quantile": q} if q is not None else {"loss": "squared_error"}
    return HistGradientBoostingRegressor(max_depth=5, learning_rate=0.07, max_iter=220, l2_regularization=2.0, min_samples_leaf=150, random_state=0, **kw)


class Dist:
    """P(stat > line | predicted mean): the empirical outcome distribution of training rows whose predicted mean was similar
    (40 buckets by predicted mean, CDFs interpolated between neighbouring buckets). Built from out-of-sample predictions, so the
    probabilities are calibrated by construction - tested: predicted over-probabilities land within ~1-2 points of reality."""

    def __init__(self, mu: np.ndarray, y: np.ndarray, n_bins: int = 40):
        qs = np.unique(np.quantile(mu, np.linspace(0, 1, n_bins + 1)))
        self.edges = qs
        idx = np.clip(np.searchsorted(qs, mu, side="right") - 1, 0, len(qs) - 2)
        self.mid = np.array([mu[idx == b].mean() for b in range(len(qs) - 1)])
        self.vals = np.arange(0, int(y.max()) + 2)
        self.cdf = np.zeros((len(qs) - 1, len(self.vals)))
        for b in range(len(qs) - 1):
            yb = y[idx == b]
            self.cdf[b] = [(yb <= v).mean() for v in self.vals]

    def cdf_at(self, mu, k):
        mu = np.asarray(mu, float)
        j = np.clip(np.searchsorted(self.mid, mu), 1, len(self.mid) - 1)
        lo, hi = self.mid[j - 1], self.mid[j]
        w = np.clip((mu - lo) / np.maximum(hi - lo, 1e-9), 0, 1)
        k = np.clip(np.asarray(k, int), 0, len(self.vals) - 1)
        return (1 - w) * self.cdf[j - 1, k] + w * self.cdf[j, k]

    def p_over(self, mu, line):
        """Chance the stat is strictly above `line` (a .5 line: over = at least ceil(line))."""
        return 1.0 - self.cdf_at(mu, np.floor(np.asarray(line, float)))

    def median(self, mu):
        mu = np.atleast_1d(np.asarray(mu, float))
        out = np.zeros(len(mu))
        for i, m in enumerate(mu):
            c = self.cdf_at(np.full(len(self.vals), m), np.arange(len(self.vals)))
            out[i] = float(np.argmax(c >= 0.5))
        return out


def project_frame(feats: pd.DataFrame, bundle: dict) -> pd.DataFrame:
    """Per target: model mean and calibrated median for each row of a feature frame (columns from feature_frame())."""
    out = {}
    for name, comps in bundle["targets"].items():
        X = feature_frame(feats, comps, name)
        mu = bundle["models"][name].predict(X)
        out[f"{name}_mean"] = mu
        out[f"{name}_median"] = bundle["dists"][name].median(mu)
    return pd.DataFrame(out, index=feats.index)


def load_played() -> pd.DataFrame:
    df = pd.read_csv(FEATURES_OUT)
    return df


def evaluate() -> None:
    df = load_played()
    played = df[df["played"] == 1].copy()
    last = int(played["season"].max())
    fc = minutes_forecasts(df, holdout=last)
    played = played.join(fc)
    played = played.dropna(subset=["pm_mean", "rate_rs" if "rate_rs" in played else "rs_pts"])
    tr, te = played[played["season"] < last], played[played["season"] == last]
    print(f"train {len(tr):,}, test {len(te):,} ({last})", flush=True)
    rows = []
    for name, comps in TARGETS.items():
        Xtr, Xte = feature_frame(tr, comps, name), feature_frame(te, comps, name)
        ytr, yte = target_values(tr, comps), target_values(te, comps)
        keep = Xtr["rate_rs"].notna()
        mean = _q(None).fit(Xtr[keep], ytr[keep])
        pm = mean.predict(Xte)
        naive = (te["fast"] * Xte["rate_rs"]).to_numpy()  # his average per-minute rate x his typical minutes
        mae_m, mae_n = float(np.mean(np.abs(yte - pm))), float(np.mean(np.abs(yte[Xte["rate_rs"].notna()] - naive[Xte["rate_rs"].notna()])))
        qs = {}
        for q in QUANTS:
            mq = _q(q).fit(Xtr[keep], ytr[keep])
            qs[q] = mq.predict(Xte)
        cover = {q: float(np.mean(yte.to_numpy() <= qs[q])) for q in QUANTS}
        med_mae = float(np.mean(np.abs(yte - qs[0.5])))
        rows.append({"stat": name, "mean_y": float(yte.mean()), "MAE_naive": mae_n, "MAE_mean_model": mae_m, "MAE_median": med_mae, "improve%": (1 - mae_m / mae_n) * 100,
                     **{f"cov{int(q * 100)}": cover[q] * 100 for q in QUANTS}})
        print(f"  {name:<7} mean {rows[-1]['mean_y']:5.2f} | MAE naive {mae_n:.3f} -> model {mae_m:.3f} ({rows[-1]['improve%']:+.1f}%) | median-model MAE {med_mae:.3f} | coverage 10/25/50/75/90: " + "/".join(f"{cover[q] * 100:.0f}" for q in QUANTS), flush=True)
    pd.DataFrame(rows).to_csv(DATA_DIR / "props_eval.csv", index=False)


def train() -> None:
    df = load_played()
    played = df[df["played"] == 1].copy()
    fc = minutes_forecasts(df, holdout=None)
    played = played.join(fc).dropna(subset=["pm_mean", "rs_pts"])
    seasons = sorted(played["season"].unique())
    models, dists = {}, {}
    for name, comps in TARGETS.items():
        X, y = feature_frame(played, comps, name), target_values(played, comps).to_numpy()
        keep = X["rate_rs"].notna().to_numpy()
        oof = np.full(len(X), np.nan)
        for s_ in seasons:  # out-of-sample means for the distribution tables
            m = (played["season"] == s_).to_numpy()
            oof[m] = _q(None).fit(X[~m & keep], y[~m & keep]).predict(X[m])
        ok = ~np.isnan(oof)
        dists[name] = Dist(oof[ok], y[ok])
        models[name] = _q(None).fit(X[keep], y[keep])
        print(f"  trained {name}", flush=True)
    with open(MODELS_OUT, "wb") as f:
        pickle.dump({"targets": TARGETS, "models": models, "dists": dists, "rows": len(played), "features_version": 2 if USE_LONG else 1}, f)
    print(f"-> {MODELS_OUT}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate", "train"])
    ap.add_argument("--long", action="store_true", help="use the long-run per-minute rates (features_version 2)")
    a = ap.parse_args()
    global USE_LONG
    USE_LONG = a.long
    evaluate() if a.what == "evaluate" else train()


if __name__ == "__main__":
    main()
