"""
Results-only walk-forward backtest of baseline.py: for each two-week block,
fit on games strictly BEFORE the block, predict every game in it, score
against what actually happened. No odds involved - this answers "are the
probabilities calibrated and better than a naive baseline," not "can it
beat the market" (that's compare_market.py).

What counts as good, judged against two reference points:
  * constant home-win rate (no skill at all) - log loss ~0.69
  * the market's own closing line, where we have it (compare_market.py) -
    the number that actually matters for betting. NHL games are close to
    coin flips, so expect model log loss within a hair of the constant
    baseline's; the question is how a model compares to the CLOSING LINE,
    not to 0.693.

Seasons are split into a tuning range and a held-out test range so the
reported numbers aren't just the best of many configs on the same games.

Usage:
    python -m nhl_model.backtest                # tune on 2018-2020, report 2021+
    python -m nhl_model.backtest --no-tune      # default config only
"""
from __future__ import annotations

import argparse
import warnings
import itertools

import numpy as np
import pandas as pd

from .baseline import Config, fit_ratings, summarize
from .team_games import TEAM_GAMES_OUT

warnings.filterwarnings("ignore", category=DeprecationWarning)

TUNE_SEASONS = (2018, 2019, 2020)
TEST_SEASONS = (2021, 2022, 2023, 2024, 2025)
BLOCK_DAYS = 14


def load() -> pd.DataFrame:
    tg = pd.read_csv(TEAM_GAMES_OUT)
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    return tg.sort_values(["start_utc", "game_id"]).reset_index(drop=True)


def walk_forward(tg: pd.DataFrame, cfg: Config, seasons: tuple[int, ...]) -> pd.DataFrame:
    home = tg[tg["is_home"] == 1].copy()
    home = home[home["season"].isin(seasons)]
    preds = []
    t0, t1 = home["start_utc"].min(), home["start_utc"].max()
    block_start = t0.normalize()
    while block_start <= t1:
        block_end = block_start + pd.Timedelta(days=BLOCK_DAYS)
        block = home[(home["start_utc"] >= block_start) & (home["start_utc"] < block_end)]
        if len(block):
            fit = fit_ratings(tg, block_start, cfg)
            if fit is not None:
                for r in block.itertuples():
                    lh, la = fit.lambdas(int(r.team_id), int(r.opp_id))
                    s = summarize(lh, la, fit.ot_home_share)
                    s.update(
                        game_id=r.game_id, season=r.season, start_utc=r.start_utc,
                        home_win=int(r.final_for > r.final_against),
                        went_to_ot=int(r.last_period != "REG"),
                        reg_total=r.goals_for_reg_official + r.goals_against_reg_official,
                        final_total=r.final_for + r.final_against,
                        reg_margin=r.goals_for_reg_official - r.goals_against_reg_official,
                    )
                    preds.append(s)
        block_start = block_end
    return pd.DataFrame(preds)


def logloss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def report(p: pd.DataFrame, label: str) -> dict:
    y = p["home_win"].to_numpy()
    # constant baseline: expanding home-win rate up to (not including) each game
    base = (p["home_win"].expanding().sum().shift(1) / np.arange(len(p))).fillna(0.54).clip(0.4, 0.65).to_numpy()
    res = {
        "n": len(p),
        "logloss_model": logloss(y, p["p_home"].to_numpy()),
        "logloss_const": logloss(y, base),
        "brier_model": float(((p["p_home"] - y) ** 2).mean()),
        "acc": float(((p["p_home"] > 0.5) == (y == 1)).mean()),
        "tot_pred": float(p["exp_total_final"].mean()),
        "tot_actual": float(p["final_total"].mean()),
        "over55_pred": float(p["p_over_5.5"].mean()),
        "over55_actual": float((p["final_total"] > 5.5).mean()),
        "m15_pred": float(p["p_home_cover_m15"].mean()),
        "m15_actual": float((p["reg_margin"] >= 2).mean()),
    }
    print(f"\n[{label}] {res['n']} games")
    print(f"  home-win log loss: model {res['logloss_model']:.4f} vs constant {res['logloss_const']:.4f}  (lower is better; gain {res['logloss_const'] - res['logloss_model']:+.4f})")
    print(f"  Brier {res['brier_model']:.4f} | accuracy {res['acc']:.3f}")
    print(f"  final total goals: predicted avg {res['tot_pred']:.3f} vs actual {res['tot_actual']:.3f} | P(over 5.5) predicted {res['over55_pred']:.3f} vs actual {res['over55_actual']:.3f}")
    print(f"  home -1.5 (reg margin >= 2): predicted {res['m15_pred']:.3f} vs actual {res['m15_actual']:.3f}")
    return res


def calibration(p: pd.DataFrame) -> None:
    d = p.assign(bin=pd.cut(p["p_home"], [0, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 1.0]))
    t = d.groupby("bin", observed=True).agg(n=("home_win", "size"), predicted=("p_home", "mean"), actual=("home_win", "mean"))
    print("  calibration (home win):")
    print(t.round(3).to_string())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-tune", action="store_true")
    a = ap.parse_args()
    tg = load()
    best = Config()
    if not a.no_tune:
        grid = list(itertools.product((75.0, 150.0, 300.0), (10.0, 30.0), (0.3, 0.6)))
        print(f"tuning {len(grid)} configs on seasons {TUNE_SEASONS} ...")
        scores = []
        for hl, k, gw in grid:
            cfg = Config(half_life_days=hl, prior_games=k, goal_weight=gw)
            r = walk_forward(tg, cfg, TUNE_SEASONS)
            scores.append((logloss(r["home_win"].to_numpy(), r["p_home"].to_numpy()), cfg))
            print(f"  half_life={hl:5.0f} prior_games={k:4.0f} goal_weight={gw:.1f} -> log loss {scores[-1][0]:.4f}")
        best = min(scores, key=lambda s: s[0])[1]
        print(f"best on tuning range: {best}")
    test = walk_forward(tg, best, TEST_SEASONS)
    report(test, f"held-out {TEST_SEASONS[0]}-{TEST_SEASONS[-1]}")
    calibration(test)
    for s in TEST_SEASONS:
        report(test[test["season"] == s], f"season {s}")
    test.to_csv(TEAM_GAMES_OUT.parent / "backtest_predictions.csv.gz", index=False)


if __name__ == "__main__":
    main()
