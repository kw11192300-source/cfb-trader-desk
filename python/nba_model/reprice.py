"""
Injury repricing: what is the injury report worth to the spread, and how much of it had the market already priced?

For a team on a given night the report loses it some rating:   S = sum_i (1 - p_i) * (minutes_i / 48) * rating_i   (and S0 = same without
the rating = minutes lost), with p_i the chance player i plays (injury_probs.json by status and hours before tip), minutes_i his
usual minutes and rating_i his lineup net rating (rapm.py). The game's injury swing is  home - away.  Each player is split into
  KNOWN   - also missed his team's previous game (the market has had days to price him), and
  NEW     - played last game, is listed now (fresh news).

Backtest on the Jan-Apr 2026 official reports (the only ones we have), ratings fit on seasons BEFORE the one tested:
  1. does the swing explain how far the line moved from open to close?                     (is the move news-driven?)
  2. does it explain actual margin minus the OPEN?                                           (was the open stale on it?)
  3. does it explain actual margin minus the CLOSE?                                          (is the close efficient on it?)

    python -m nba_model.reprice backtest
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .injuries import ET
from .minutes import FEATURES_OUT
from .parse import GAMES_OUT, ODDS_OUT, PLAYER_GAMES_OUT
from .teammodel import ratings_as_of

PARSED = DATA_DIR / "injury_reports.csv.gz"
PROBS = DATA_DIR / "injury_probs.json"


def _key(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def p_play(status: str, hours: float, probs: dict) -> float:
    b = "<1.5h" if hours < 1.5 else "1.5-3h" if hours < 3 else "3-6h" if hours < 6 else "6-12h" if hours < 12 else "12h+"
    return probs["by_bucket"].get(f"{status}|{b}", probs["overall"].get(status, 1.0))


def ols(y: np.ndarray, X: np.ndarray, names: list[str]) -> None:
    X1 = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(X1, y, rcond=None)
    res = y - X1 @ beta
    cov = np.linalg.inv(X1.T @ X1) * (res @ res) / (len(y) - X1.shape[1])
    se = np.sqrt(np.diag(cov))
    r2 = 1 - (res @ res) / ((y - y.mean()) @ (y - y.mean()))
    print("   " + " | ".join(f"{n} {b:+.3f} (t {b / s:+.1f})" for n, b, s in zip(["const"] + names, beta, se)) + f" | R2 {r2:.3f} n={len(y)}")


def build_swings(season: int, first_date: str = "2026-01-05") -> pd.DataFrame:
    probs = json.load(open(PROBS))
    rat = ratings_as_of(season - 1).set_index("player_id")
    rat["net"] = rat["off"] - rat["def"]  # def = points allowed, so net = off - def
    feats = pd.read_csv(FEATURES_OUT, usecols=["event_id", "season", "start_utc", "team_id", "player_id", "slow", "played", "gap_games"])
    feats = feats[feats["season"] == season]
    pg = pd.read_csv(PLAYER_GAMES_OUT, usecols=["event_id", "team_id", "player_id", "name"])
    names = pg.drop_duplicates(["event_id", "team_id", "player_id"])
    names["k"] = names["name"].map(_key)
    f = feats.merge(names[["event_id", "team_id", "player_id", "k"]], on=["event_id", "team_id", "player_id"], how="left")
    f["net"] = f["player_id"].map(rat["net"]).fillna(0.0)
    f["share"] = (f["slow"].clip(upper=40) / 48.0).where(f["slow"] >= 6, 0.0)

    rep = pd.read_csv(PARSED)
    rep = rep[rep["player"].notna() & rep["status"].isin(["Out", "Doubtful", "Questionable", "Probable", "Available"])].copy()
    rep["report_time"] = pd.to_datetime(rep["report_time"], utc=True)
    rep["game_date"] = pd.to_datetime(rep["game_date"], format="%m/%d/%Y").dt.date
    rep["k"] = rep["player"].map(_key)
    gm = pd.read_csv(GAMES_OUT)
    gm["start_utc"] = pd.to_datetime(gm["start_utc"], utc=True)
    gm["et_date"] = gm["start_utc"].dt.tz_convert(ET).dt.date
    teams = pd.concat([gm[["event_id", "et_date", "start_utc", "home"]].rename(columns={"home": "team"}), gm[["event_id", "et_date", "start_utc", "away"]].rename(columns={"away": "team"})])
    rep = rep.merge(teams, left_on=["game_date", "team"], right_on=["et_date", "team"], how="inner")
    rep["hours"] = (rep["start_utc"] - rep["report_time"]).dt.total_seconds() / 3600.0
    rep = rep[rep["hours"] > 0.2].sort_values("report_time").groupby(["event_id", "team", "k"]).tail(1)  # the last report before tip
    rep["p"] = [p_play(s, h, probs) for s, h in zip(rep["status"], rep["hours"])]
    # attach to roster rows by (event, team name, name key)
    tid = pd.concat([gm[["event_id", "home", "home_id"]].set_axis(["event_id", "team", "team_id"], axis=1), gm[["event_id", "away", "away_id"]].set_axis(["event_id", "team", "team_id"], axis=1)])
    rep = rep.merge(tid, on=["event_id", "team"], how="left")
    f = f.merge(rep[["event_id", "team_id", "k", "p", "status"]], on=["event_id", "team_id", "k"], how="left")
    f["p"] = f["p"].fillna(1.0)
    f["miss"] = 1.0 - f["p"]
    f["known"] = (f["gap_games"] >= 1)
    f["S1"], f["S0"] = f["miss"] * f["share"] * f["net"], f["miss"] * f["share"]
    # oracle: who actually sat (minutes features' own notion), for comparison
    f["O1"], O0 = (1 - f["played"]) * f["share"] * f["net"], (1 - f["played"]) * f["share"]
    f["O0"] = O0
    agg = f.groupby(["event_id", "team_id"]).apply(
        lambda d: pd.Series(
            {
                "S1k": d.loc[d.known, "S1"].sum(), "S0k": d.loc[d.known, "S0"].sum(), "S1n": d.loc[~d.known, "S1"].sum(), "S0n": d.loc[~d.known, "S0"].sum(),
                "O1": d["O1"].sum(), "O0": d["O0"].sum(), "listed": d["p"].lt(1).sum(),
            }
        )
    ).reset_index()
    g = gm[gm["season"] == season].merge(pd.read_csv(ODDS_OUT)[["event_id", "spread_home_open", "spread_home_close"]], on="event_id", how="left")
    h = agg.rename(columns=lambda c: c if c in ("event_id", "team_id") else c + "_h")
    a = agg.rename(columns=lambda c: c if c in ("event_id", "team_id") else c + "_a")
    g = g.merge(h, left_on=["event_id", "home_id"], right_on=["event_id", "team_id"]).merge(a, left_on=["event_id", "away_id"], right_on=["event_id", "team_id"])
    for c in ("S1k", "S0k", "S1n", "S0n", "O1", "O0"):
        g[f"d{c}"] = g[f"{c}_h"] - g[f"{c}_a"]  # + = home loses more than away
    g["margin"] = g["home_pts"] - g["away_pts"]
    return g[g["start_utc"] >= pd.Timestamp(first_date, tz="UTC")]


def backtest() -> None:
    g = build_swings(2025)
    print(f"{len(g)} games from Jan 5 2026 with reports; {g['spread_home_open'].notna().sum()} with open and close lines")
    L = g.dropna(subset=["spread_home_open", "spread_home_close"]).copy()
    L["open_m"], L["close_m"] = -L["spread_home_open"], -L["spread_home_close"]
    L["move"] = L["close_m"] - L["open_m"]  # + = the line moved toward home
    # signs: losing a player lowers that team's margin, so the swing regressors enter negatively
    for c in ("dS1k", "dS0k", "dS1n", "dS0n", "dO1", "dO0"):
        L[c] = -L[c]
    print(f"line move open->close: mean {L.move.mean():+.2f}, sd {L.move.std():.2f}; swing (known+new, rating part) sd {(L.dS1k + L.dS1n).std():.2f}")
    sets = {"report, split known/new": ["dS1k", "dS0k", "dS1n", "dS0n"], "report, total": None}
    L["dS1"], L["dS0"] = L["dS1k"] + L["dS1n"], L["dS0k"] + L["dS0n"]
    for tgt, label in (("move", "1. line move (close - open)"), ("m_open", "2. actual margin - open"), ("m_close", "3. actual margin - close")):
        L["m_open"], L["m_close"] = L["margin"] - L["open_m"], L["margin"] - L["close_m"]
        print(f"\n{label}")
        ols(L[tgt].to_numpy(), L[["dS1k", "dS0k", "dS1n", "dS0n"]].to_numpy(), ["S1known", "S0known", "S1new", "S0new"])
        ols(L[tgt].to_numpy(), L[["dS1", "dS0"]].to_numpy(), ["S1", "S0"])
        ols(L[tgt].to_numpy(), L[["dO1", "dO0"]].to_numpy(), ["oracleS1", "oracleS0"])
    L.to_pickle(DATA_DIR / "reprice_eval.pkl")


def calibrate() -> None:
    """Fit the fresh-news coefficients live.py uses:  move = c1 * (S1_away - S1_home) + c0 * (S0_away - S0_home)  on the backtest games."""
    L = pd.read_pickle(DATA_DIR / "reprice_eval.pkl")
    X = np.column_stack([np.ones(len(L)), L["dS1n"], L["dS0n"]])
    beta, *_ = np.linalg.lstsq(X, L["move"].to_numpy(), rcond=None)
    out = {"c1": float(beta[1]), "c0": float(beta[2]), "n": int(len(L)), "fit": "open->close move on fresh-news swing, Jan-Apr 2026"}
    path = Path(__file__).resolve().parents[1] / "models" / "nba_reprice.json"
    path.write_text(json.dumps(out, indent=1))
    print(out, "->", path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["backtest", "calibrate"])
    a = ap.parse_args()
    backtest() if a.what == "backtest" else calibrate()


if __name__ == "__main__":
    main()
