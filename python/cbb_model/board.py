"""
The CBB game board: for every upcoming game, what we project, where we expect each line to CLOSE, and which side earns
closing-line value (CLV) at the number that is up now.

For one game the board holds
  - model:   our spread / total / win probability and fair moneylines (published team ratings, totals calibration),
  - market:  ESPN's open, the current line, and its age,
  - move:    the movement model's expected close - open for the spread and the total (movement.py), so
             expected close = open + predicted move, and the bet that earns CLV is the side the line should move toward,
  - bets:    spread / total / moneyline, each with the side, the expected CLV in points (or in implied probability for ML),
             our cover/over probability and EV at the posted price, and a mover rank.

A line that has already moved is handled by measuring against the expected CLOSE, not the open: the remaining expected move is
(open + predicted move) - current.

Usage:
    python -m cbb_model.board refresh [--days 3] [--dry-run]     # score upcoming games from Supabase, write cbb_game_board
    python -m cbb_model.board replay 2025-01-18                  # what the board would have said for a past date (no network)
"""
from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

from .ingest import DATA_DIR
from .movement import FEATURES, MODEL, add_features

MARGIN_SD = 11.3  # measured: sd of (actual margin - closing margin) 11.27, vs our own projection 11.88
MARKET_ML_SD = 11.83  # how the market's moneylines map to its spread (fitted on 22k closing lines)
TOTAL_SD = 16.8  # sd of (actual total - closing total) 16.5; ours 17.1
REPO_MODEL = Path(__file__).resolve().parents[1] / "models" / "movement_model.pkl"
MIN_CLV = 0.25  # points: below this the expected move is noise; no side is flagged


def american(p: float) -> int | None:
    """Fair American price for a win probability."""
    if not (0.001 < p < 0.999):
        return None
    return int(round(-100 * p / (1 - p))) if p >= 0.5 else int(round(100 * (1 - p) / p))


def implied(price: float | None) -> float | None:
    if price is None or (isinstance(price, float) and np.isnan(price)):
        return None
    return -price / (-price + 100) if price < 0 else 100 / (price + 100)


def load_model() -> dict:
    path = MODEL if MODEL.exists() else REPO_MODEL
    with open(path, "rb") as f:
        return pickle.load(f)


def score(df: pd.DataFrame, bundle: dict) -> pd.DataFrame:
    """df: one row per game with `spread`, `total` (our calibrated numbers), `mo`/`total_open` (the open), `cur_margin`/`cur_total`
    (the number up now; = open when nothing has moved), the movement-model features, and optional `cur_ml_home/away`,
    `cur_spread_odds`, `over_odds`/`under_odds`. Returns df with the board columns added."""
    out = df.copy()
    X = out[FEATURES].astype(float)
    out["pred_move_s"] = bundle["models"]["mv_s"].predict(X)
    out["pred_move_t"] = bundle["models"]["mv_t"].predict(X)
    out["exp_close_margin"] = out["mo"] + out["pred_move_s"]
    out["exp_close_total"] = out["total_open"] + out["pred_move_t"]
    # remaining expected move from where the number sits now
    out["rem_s"] = out["exp_close_margin"] - out["cur_margin"]
    out["rem_t"] = out["exp_close_total"] - out["cur_total"]
    # spread bet: if the home margin is expected to rise, home at the current number earns CLV
    out["spread_side"] = np.where(out["rem_s"].abs() >= MIN_CLV, np.where(out["rem_s"] > 0, "home", "away"), None)
    out["spread_clv"] = out["rem_s"].abs()
    out["total_side"] = np.where(out["rem_t"].abs() >= MIN_CLV, np.where(out["rem_t"] > 0, "over", "under"), None)
    out["total_clv"] = out["rem_t"].abs()
    # our own price (independent of the move): cover / over probabilities at the current number
    out["model_win_home"] = norm.cdf(out["spread"] / MARGIN_SD)
    out["p_home_cover"] = norm.cdf((out["spread"] - out["cur_margin"]) / MARGIN_SD)  # model margin beats the current home margin
    out["p_over"] = norm.cdf((out["total"] - out["cur_total"]) / TOTAL_SD)
    # moneyline: expected closing price from the expected closing margin through the market's own spread->ML mapping
    out["exp_close_p_home"] = norm.cdf(out["exp_close_margin"] / MARKET_ML_SD)
    out["cur_p_home"] = np.where(
        out.get("cur_ml_home").notna() & out.get("cur_ml_away").notna(),
        [
            (lambda a, b: a / (a + b) if a is not None and b is not None else np.nan)(implied(h), implied(a))
            for h, a in zip(out.get("cur_ml_home"), out.get("cur_ml_away"))
        ],
        norm.cdf(out["cur_margin"] / MARKET_ML_SD),
    )
    out["ml_clv_p"] = out["exp_close_p_home"] - out["cur_p_home"]  # + = home price should shorten: bet home now
    out["ml_side"] = np.where(out["ml_clv_p"].abs() >= 0.006, np.where(out["ml_clv_p"] > 0, "home", "away"), None)
    out["mover_rank"] = out["rem_s"].abs().rank(ascending=False, method="first")  # NaN where no line is posted yet
    return out


def row_payload(r: pd.Series) -> dict:
    f = lambda v, n=2: None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), n)  # noqa: E731
    return {
        "teams": {"home": r.get("home_school"), "away": r.get("away_school")},
        "model": {
            "spread": f(r["spread"]), "total": f(r["total"]), "home_win": f(r["model_win_home"], 4), "poss": f(r.get("poss"), 1),
            "fair_ml_home": american(float(r["model_win_home"])), "fair_ml_away": american(1 - float(r["model_win_home"])),
            "home_pts": f((r["total"] + r["spread"]) / 2, 1), "away_pts": f((r["total"] - r["spread"]) / 2, 1),
        },
        "market": {
            "open_margin": f(r["mo"]), "open_total": f(r["total_open"]), "cur_margin": f(r["cur_margin"]), "cur_total": f(r["cur_total"]),
            "ml_home": f(r.get("cur_ml_home"), 0), "ml_away": f(r.get("cur_ml_away"), 0),
            "spread_odds": f(r.get("cur_spread_odds"), 0), "over_odds": f(r.get("over_odds"), 0), "under_odds": f(r.get("under_odds"), 0),
        },
        "move": {
            "spread": f(r["pred_move_s"]), "total": f(r["pred_move_t"]), "exp_close_margin": f(r["exp_close_margin"]), "exp_close_total": f(r["exp_close_total"]),
            "remaining_spread": f(r["rem_s"]), "remaining_total": f(r["rem_t"]), "mover_rank": f(r["mover_rank"], 0),
        },
        "bets": {
            "spread": {"side": r["spread_side"], "clv": f(r["spread_clv"]), "p_cover_home": f(r["p_home_cover"], 4)},
            "total": {"side": r["total_side"], "clv": f(r["total_clv"]), "p_over": f(r["p_over"], 4)},
            "ml": {"side": r["ml_side"], "clv_p": f(r["ml_clv_p"], 4), "exp_close_p_home": f(r["exp_close_p_home"], 4), "cur_p_home": f(r["cur_p_home"], 4)},
        },
        "drivers": {k: f(r.get(k)) for k in ("gap_s", "gap_t", "f10_m_h", "f10_m_a", "rest_h", "rest_a")},
    }


# --------------------------------------------------------------------------------------------- replay (offline)

def replay(date: str, top: int = 12) -> None:
    ds = pd.read_pickle(DATA_DIR / "movement_dataset.pkl")
    day = ds[ds["start_utc"].dt.strftime("%Y-%m-%d") == date].copy()
    if day.empty:
        print("no games with lines on", date)
        return
    bundle = load_model()
    day["cur_margin"], day["cur_total"] = day["mo"], day["total_open"]  # at the open, nothing has moved
    day["cur_ml_home"], day["cur_ml_away"] = np.nan, np.nan
    # NB: the saved model was trained on these games; replay shows the board's format, not an out-of-sample result
    b = score(day, bundle)
    names = pd.read_csv(DATA_DIR / "teams.csv").drop_duplicates("id").set_index("id")["name"]
    b["home"] = b["home_id"].map(names)
    b["away"] = b["away_id"].map(names)
    cols = ["away", "home", "mo", "spread", "pred_move_s", "exp_close_margin", "spread_side", "spread_clv", "total_open", "total", "pred_move_t", "total_side", "total_clv", "actual_margin", "mc", "total_close"]
    print(f"{len(b)} games on {date}; sorted by expected spread move")
    print(b.sort_values("spread_clv", ascending=False)[cols].head(top).round(2).to_string(index=False))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["refresh", "replay"])
    ap.add_argument("date", nargs="?")
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.what == "replay":
        replay(a.date or "2025-01-18")
    else:
        from .board_live import refresh

        refresh(days=a.days, dry_run=a.dry_run)


if __name__ == "__main__":
    main()
