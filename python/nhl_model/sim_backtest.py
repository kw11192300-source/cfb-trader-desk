"""
Walk-forward backtest of the strength-state simulation (sim.py).

Same protocol as backtest.py: two-week blocks, fit ONLY on earlier games,
simulate every game in the block, score against what happened. Then the
three things the simulation exists for, each against actuals AND against
the market's own closing line on the same games:

  * win probability        (log loss vs the de-vigged consensus moneyline)
  * game totals            (P(over the book's line) vs the over/under prices)
  * puck line +/-1.5       (P(home covers) vs the puck-line prices)

and distribution diagnostics - does the simulated spread of totals,
margins, and power-play time look like real hockey? That's where the
independent-Poisson baseline failed, so it's the first thing to check.

Conventions (US books): totals and puck lines settle on the OFFICIAL final
score, where a shootout winner is credited one extra goal; totals that land
exactly on the line are a push and are excluded from scoring (market and
model are both compared on the no-push conditional probability).

Usage:
    python -m nhl_model.sim_backtest                   # held-out 2021-25, 20k sims/game
    python -m nhl_model.sim_backtest --sims 4000 --tune
"""
from __future__ import annotations

import argparse
import itertools
import time
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .backtest import BLOCK_DAYS, TEST_SEASONS, TUNE_SEASONS, logloss
from .goalie_model import fit_poisson_offset, pregame_goalie_ratings
from .ingest import DATA_DIR
from .odds import ODDS_OUT, devig2, market_consensus
from .sim import GameParams, RateModel, REG_SECONDS_SIM, SimConfig, Tables, fit_rate_model, load_tables, simulate, summarize_sim
from .sim_inputs import SIM_TEAM_GAMES_OUT

warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message="Unknown solver options")

SIM_PRED_OUT = DATA_DIR / "sim_predictions.csv.gz"
SIM_PRED_NOGOALIE_OUT = DATA_DIR / "sim_predictions_nogoalie.csv.gz"
GOALIE_PRIOR_ATTEMPTS = 1000.0
BOOK_PREFERENCE = ["DraftKings", "Draft Kings", "ESPN BET", "Bet365", "Caesars Sportsbook", "MGM"]


@dataclass
class BlockFit:
    ev: RateModel
    pp: RateModel
    pen: RateModel
    r_sh: float
    conv: float
    beta: float
    gbar: float
    cfg: SimConfig
    pp_scale: float = 1.0

    def params(self, home: int, away: int, g_home: float, g_away: float) -> GameParams:
        return GameParams(
            r_ev_h=self.ev.rate(home, away, True), r_ev_a=self.ev.rate(away, home, False),
            r_pp_h=self.pp.rate(home, away, True), r_pp_a=self.pp.rate(away, home, False),
            pens_h=self.pen.rate(home, away, True) * self.pp_scale, pens_a=self.pen.rate(away, home, False) * self.pp_scale,
            r_sh=self.r_sh,
            conv_h=self.conv * float(np.exp(self.beta * (g_away - self.gbar))),  # home shots face the AWAY goalie
            conv_a=self.conv * float(np.exp(self.beta * (g_home - self.gbar))),
        )


def load_sim_team_games(gr: pd.DataFrame) -> pd.DataFrame:
    tg = pd.read_csv(SIM_TEAM_GAMES_OUT)
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    tg = tg.merge(gr, on="game_id", how="left")
    tg["own_goalie_rating"] = np.where(tg["is_home"] == 1, tg["home_goalie_rating"], tg["away_goalie_rating"]).astype(float)
    tg["opp_goalie_rating"] = np.where(tg["is_home"] == 1, tg["away_goalie_rating"], tg["home_goalie_rating"]).astype(float)
    tg[["own_goalie_rating", "opp_goalie_rating"]] = tg[["own_goalie_rating", "opp_goalie_rating"]].fillna(0.0)
    return tg.sort_values(["start_utc", "game_id"]).reset_index(drop=True)


def fit_block(tg: pd.DataFrame, as_of: pd.Timestamp, cfg: SimConfig, tb: Tables) -> BlockFit | None:
    train = tg[(tg["start_utc"] < as_of) & (tg["start_utc"] >= as_of - pd.Timedelta(days=cfg.lookback_days))]
    if len(train) < 600:
        return None
    hl = cfg.half_life_days
    ev = fit_rate_model(train, "xg_reg_ev", "ev_min", as_of, hl, cfg.prior_games_ev)
    pp = fit_rate_model(train, "xg_reg_pp", "pp_min", as_of, hl, cfg.prior_games_pp)
    pen = fit_rate_model(train, "pens_drawn", None, as_of, hl, cfg.prior_games_pen)
    r_sh = float(train["xg_reg_pk"].sum() / max(train["pk_min"].sum(), 1.0))

    t = train[train["xg_reg"] > 0]
    age = (as_of - t["start_utc"]).dt.total_seconds().to_numpy() / 86400.0
    w = np.exp(-np.log(2) * age / hl)
    y, off = t["goals_reg"].to_numpy(float), np.log(t["xg_reg"].to_numpy())
    if cfg.use_goalie:
        x = t["opp_goalie_rating"].to_numpy()
        gbar = float(np.average(x, weights=w))
        a, beta = fit_poisson_offset(y, off, x - gbar, w)
    else:
        gbar, beta = 0.0, 0.0
        a = float(np.log(np.sum(w * y) / np.sum(w * np.exp(off))))
    fit = BlockFit(ev, pp, pen, r_sh, float(np.exp(a)), float(beta), gbar, cfg, pp_scale=cfg.pp_opps_scale)
    calibrate(fit, train, as_of, tb)
    return fit


def calibrate(fit: BlockFit, train: pd.DataFrame, as_of: pd.Timestamp, tb: Tables) -> None:
    """Make a simulated LEAGUE-AVERAGE game reproduce the training window's
    power-play minutes and regulation goals (both recency-weighted). Two
    reasons it's needed: the penalty count includes offsetting penalties that
    never produce a power play, and chance-rates fit per state don't have to
    add back up to the right total. Calibrating the level (not the team
    differences) leaves every team's relative strength untouched."""
    age = (as_of - train["start_utc"]).dt.total_seconds().to_numpy() / 86400.0
    # league-wide levels (scoring, penalties) drift year to year but are estimated from
    # thousands of games, so track them on a SHORT window - the team ratings keep the long one
    w = np.exp(-np.log(2) * age / fit.cfg.level_half_life_days)
    target_pp_min = float(np.average(train["pp_min"], weights=w))
    home = train["is_home"].to_numpy() == 1
    target_total = float(np.average(train["goals_for_reg_official"] + train["goals_against_reg_official"], weights=w))
    avg = fit.params(-1, -2, fit.gbar, fit.gbar)  # unseen team ids -> league-average ratings, no goalie effect
    s = simulate(avg, tb, 20000, seed=7)
    sim_pp_min = (s["pp_len_h"].mean() + s["pp_len_a"].mean()) / 2.0 / 60.0 * (3600.0 / REG_SECONDS_SIM)
    fit.pp_scale *= target_pp_min / max(sim_pp_min, 1e-9)
    avg = fit.params(-1, -2, fit.gbar, fit.gbar)
    s = simulate(avg, tb, 20000, seed=8)
    first57 = float((s["h57"] + s["a57"]).mean())
    late = float((s["reg_h"] + s["reg_a"]).mean()) - first57
    fit.conv *= max(target_total - late, 0.5) / first57


def walk_forward_sim(tg: pd.DataFrame, tb: Tables, cfg: SimConfig, seasons: tuple[int, ...], n_sims: int, verbose: bool = False) -> pd.DataFrame:
    home = tg[(tg["is_home"] == 1) & tg["season"].isin(seasons)]
    rows = []
    block_start = home["start_utc"].min().normalize()
    t_end = home["start_utc"].max()
    t0 = time.time()
    while block_start <= t_end:
        block_end = block_start + pd.Timedelta(days=BLOCK_DAYS)
        block = home[(home["start_utc"] >= block_start) & (home["start_utc"] < block_end)]
        fit = fit_block(tg, block_start, cfg, tb) if len(block) else None
        if fit is not None:
            for r in block.itertuples():
                gp = fit.params(int(r.team_id), int(r.opp_id), r.own_goalie_rating, r.opp_goalie_rating)
                s = summarize_sim(simulate(gp, tb, n_sims, seed=int(r.game_id) % 2_000_000_011))
                s.update(game_id=r.game_id, season=r.season, start_utc=r.start_utc, beta=fit.beta,
                         home_win=int(r.final_for > r.final_against), final_total=r.final_for + r.final_against,
                         final_margin=r.final_for - r.final_against, reg_total=r.goals_for_reg_official + r.goals_against_reg_official,
                         actual_pp_min_h=r.pp_min, actual_pp_min_a=r.pk_min, went_to_so=int(r.last_period == "SO"))
                rows.append(s)
        if verbose and rows and len(rows) % 1000 < len(block):
            print(f"  {len(rows)} games simulated, {time.time() - t0:.0f}s")
        block_start = block_end
    return pd.DataFrame(rows)


# ------------------------------------------------------------ evaluation

def _pick_book(o: pd.DataFrame) -> pd.DataFrame:
    """One row per game, preferring a fixed book order so every game isn't weighted by how many books quoted it."""
    rank = o["provider"].map({b: i for i, b in enumerate(BOOK_PREFERENCE)}).fillna(len(BOOK_PREFERENCE))
    return o.assign(_r=rank).sort_values(["game_id", "_r"]).drop_duplicates("game_id").drop(columns="_r")


def _over_prob(row: pd.Series, line: float) -> float:
    tot = np.array([row[f"pt_{k}"] for k in range(17)])
    over, under = tot[np.arange(17) > line].sum(), tot[np.arange(17) < line].sum()
    return float(over / (over + under))


def evaluate(p: pd.DataFrame, label: str) -> None:
    y = p["home_win"].to_numpy()
    print(f"\n=== {label}: {len(p)} games ===")
    print(f"home-win log loss {logloss(y, p['p_home'].to_numpy()):.4f} | accuracy {((p['p_home'] > 0.5) == (y == 1)).mean():.3f}")

    # --- distribution diagnostics: simulated vs actual
    print("\nfinal-score total goals: simulated vs actual frequency")
    rows = []
    for k in range(2, 11):
        rows.append({"total": k if k < 10 else "10+", "sim": p[[f"pt_{j}" for j in range(k, 17)]].sum(axis=1).mean() if k == 10 else p[f"pt_{k}"].mean(),
                     "actual": (p["final_total"] >= k).mean() if k == 10 else (p["final_total"] == k).mean()})
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print(f"mean final total: sim {p['exp_total_final'].mean():.3f} vs actual {p['final_total'].mean():.3f}"
          f" | std of totals: sim {np.sqrt((p[[f'pt_{k}' for k in range(17)]].mul(np.arange(17) ** 2).sum(axis=1) - p['exp_total_final'] ** 2).mean()):.3f} vs actual {p['final_total'].std():.3f}")
    rows = []
    for m in (1, 2, 3, 4):
        rows.append({"home margin": f">= {m}", "sim": p[[f"pm_{k}" for k in range(m, 9)]].sum(axis=1).mean(), "actual": (p["final_margin"] >= m).mean()})
    for m in (1, 2, 3, 4):
        rows.append({"home margin": f"<= -{m}", "sim": p[[f"pm_{k}" for k in range(-8, -m + 1)]].sum(axis=1).mean(), "actual": (p["final_margin"] <= -m).mean()})
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print(f"shootout rate: sim {p['p_shootout'].mean():.3f} vs actual {p['went_to_so'].mean():.3f} | "
          f"power-play minutes per team-game: sim {(p['exp_pp_min_h'].mean() + p['exp_pp_min_a'].mean()) / 2:.2f} vs actual {(p['actual_pp_min_h'].mean() + p['actual_pp_min_a'].mean()) / 2:.2f}")

    # --- against the market
    odds = pd.read_csv(ODDS_OUT)
    closes = odds[odds["total_close"].notna() & odds["over_close"].notna() & odds["under_close"].notna() & (odds["era"] == "close")]
    d = _pick_book(closes).merge(p, on="game_id", suffixes=("_m", ""))
    d = d[d["final_total"] != d["total_close"]]  # drop pushes
    if len(d):
        d["mkt_over"] = [devig2(o, u) for o, u in zip(d["over_close"], d["under_close"])]
        d["sim_over"] = [_over_prob(r, r["total_close"]) for _, r in d.iterrows()]
        d["went_over"] = (d["final_total"] > d["total_close"]).astype(int)
        yy = d["went_over"].to_numpy()
        print(f"\nTOTALS vs book line (n={len(d)}, pushes dropped): log loss sim {logloss(yy, d['sim_over'].to_numpy()):.4f} | market {logloss(yy, d['mkt_over'].to_numpy()):.4f}"
              f" | 50/50 {logloss(yy, 0.5 * d['sim_over'].to_numpy() + 0.5 * d['mkt_over'].to_numpy()):.4f} | const {logloss(yy, np.full(len(yy), yy.mean())):.4f}")
        print(f"  mean P(over): sim {d['sim_over'].mean():.3f} market {d['mkt_over'].mean():.3f} actual {yy.mean():.3f} | mean line {d['total_close'].mean():.2f}")
        b = d.assign(bin=pd.cut(d["sim_over"], [0, 0.40, 0.45, 0.50, 0.55, 0.60, 1.0])).groupby("bin", observed=True).agg(n=("went_over", "size"), sim=("sim_over", "mean"), market=("mkt_over", "mean"), actual=("went_over", "mean"))
        print(b.round(3).to_string())

    pl = odds[odds["pl_home_close"].isin([-1.5, 1.5]) & odds["pl_home_price_close"].notna() & odds["pl_away_price_close"].notna() & (odds["era"] == "close")]
    d = _pick_book(pl).merge(p, on="game_id", suffixes=("_m", ""))
    if len(d):
        d["mkt_cover"] = [devig2(h, a) for h, a in zip(d["pl_home_price_close"], d["pl_away_price_close"])]
        d["sim_cover"] = [
            float(sum(r[f"pm_{k}"] for k in range(-8, 9) if (k > 1.5 if r["pl_home_close"] == -1.5 else k > -1.5))) for _, r in d.iterrows()
        ]
        d["covered"] = [int(m > 1.5) if pl_ == -1.5 else int(m > -1.5) for m, pl_ in zip(d["final_margin"], d["pl_home_close"])]
        yy = d["covered"].to_numpy()
        print(f"\nPUCK LINE +/-1.5, home side (n={len(d)}): log loss sim {logloss(yy, d['sim_cover'].to_numpy()):.4f} | market {logloss(yy, d['mkt_cover'].to_numpy()):.4f}"
              f" | 50/50 {logloss(yy, 0.5 * d['sim_cover'].to_numpy() + 0.5 * d['mkt_cover'].to_numpy()):.4f} | const {logloss(yy, np.full(len(yy), yy.mean())):.4f}")
        print(f"  mean P(cover): sim {d['sim_cover'].mean():.3f} market {d['mkt_cover'].mean():.3f} actual {yy.mean():.3f}")

    mkt = market_consensus(odds)
    d = p.merge(mkt[["game_id", "mkt_p_home", "era"]], on="game_id")
    d = d[d["era"] == "close"]
    yy = d["home_win"].to_numpy()
    print(f"\nWIN PROB vs market close (n={len(d)}): sim {logloss(yy, d['p_home'].to_numpy()):.4f} | market {logloss(yy, d['mkt_p_home'].to_numpy()):.4f}"
          f" | 50/50 {logloss(yy, 0.5 * d['p_home'].to_numpy() + 0.5 * d['mkt_p_home'].to_numpy()):.4f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=20000)
    ap.add_argument("--tune", action="store_true")
    ap.add_argument("--no-goalie", action="store_true")
    a = ap.parse_args()
    tb = load_tables()
    gr = pregame_goalie_ratings(GOALIE_PRIOR_ATTEMPTS)
    tg = load_sim_team_games(gr)
    cfg = SimConfig(use_goalie=not a.no_goalie)
    if a.tune:
        print(f"tuning on {TUNE_SEASONS} with {a.sims} sims/game ...")
        best = None
        for hl, pe, pp in itertools.product((300.0, 600.0), (10.0, 30.0, 80.0), (40.0, 120.0)):
            c = SimConfig(half_life_days=hl, prior_games_ev=pe, prior_games_pp=pp, use_goalie=cfg.use_goalie)
            r = walk_forward_sim(tg, tb, c, TUNE_SEASONS, a.sims)
            win = logloss(r["home_win"].to_numpy(), r["p_home"].to_numpy())
            tot = float(-np.log(np.clip([row[f"pt_{min(int(t), 16)}"] for row, t in zip(r.to_dict("records"), r["final_total"])], 1e-4, 1)).mean())
            mar = float(-np.log(np.clip([row[f"pm_{int(np.clip(m, -8, 8))}"] for row, m in zip(r.to_dict("records"), r["final_margin"])], 1e-4, 1)).mean())
            score = win + tot + mar
            print(f"  half_life={hl:4.0f} prior_ev={pe:3.0f} prior_pp={pp:3.0f} -> win {win:.4f} | total NLL {tot:.4f} | margin NLL {mar:.4f} | sum {score:.4f}")
            best = min(best, (score, c), key=lambda t: t[0]) if best else (score, c)
        cfg = best[1]
        print("best:", cfg)
    t0 = time.time()
    p = walk_forward_sim(tg, tb, cfg, TEST_SEASONS, a.sims, verbose=True)
    print(f"simulated {len(p)} held-out games in {time.time() - t0:.0f}s")
    p.to_csv(SIM_PRED_OUT if cfg.use_goalie else SIM_PRED_NOGOALIE_OUT, index=False)
    evaluate(p, f"strength-state sim, held-out {TEST_SEASONS[0]}-{TEST_SEASONS[-1]} (goalie={'oracle' if cfg.use_goalie else 'none'})")


if __name__ == "__main__":
    main()
