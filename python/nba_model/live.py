"""
Live NBA projections for the games on the board: projected minutes and stat lines for every player, and what the injury report is worth
to the spread compared with how far the line has already moved.

Pipeline for one run (a few minutes in GitHub Actions; triggered whenever the injury report changes):
  1. the rolling state after the last finished game (every player's minutes / per-minute-rate baselines, team pace, rest) - minutes.build(emit=False)
  2. each team's roster (ESPN) and each listed player's chance to play (the official report x the calibrated status table)
  3. SCENARIOS: the uncertain players (Questionable ...) are in or out; every combination (or a sample) is weighted by probability, and
     for each one the minutes model sees who is out and hands the minutes to the next men up; the stat models then project each player
     from those minutes. Everything is averaged over scenarios, so a Questionable star shows up as a blend, not a guess.
  4. NEWS MOVE: the report's worth to the spread from FRESH news only (players who played their last game and are now listed - the
     part the market has not had days to price), using the coefficients fitted in reprice.py. Compared with the line's move since open.

    python -m nba_model.live run                 # project the games on the board and publish
    python -m nba_model.live run --dry-run
    python -m nba_model.live check <event_id>    # replay one finished game with its actual lineup: do the features match the stored table?
"""
from __future__ import annotations

import argparse
import itertools
import json
import pickle
import re
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .minutes import COLD, FEATURES_OUT, STATS, XCOLS, build as build_state
from .props import feature_frame

MODELS = Path(__file__).resolve().parents[1] / "models"
VAC_KEYS = ("pts", "reb", "ast", "tpm", "fga")
MAX_ENUM = 6  # up to this many uncertain players per team: every combination; beyond it a weighted sample
N_SAMPLE = 64
ROT = 8.0  # a "rotation" player: usual minutes at least this


def _key(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


# ------------------------------------------------------------------ features for one team under one availability scenario

def _base_feats(st: dict | None, season: int) -> dict:
    if st is None:
        return {"fast": COLD, "slow": COLD, "last": COLD, "last5": COLD, "season_mean": COLD, "start_rate": 0.0, "n_prior": 0, "gap_games": 0}
    l5 = st["recent"][-5:]
    return {
        "fast": st["fast"], "slow": st["slow"], "last": st["recent"][-1], "last5": float(np.mean(l5)),
        "season_mean": st["season_sum"] / max(st["season_n"], 1) if st["season"] == season else st["slow"],
        "start_rate": st["start"], "n_prior": st["n"], "gap_games": int(st["team_games_since"]),
    }


def _rates(st: dict | None, season: int) -> dict:
    out = {}
    for k in STATS:
        if st is None:
            out[f"rf_{k}"] = out[f"rs_{k}"] = out[f"rsea_{k}"] = out[f"rl_{k}"] = np.nan
        else:
            out[f"rf_{k}"] = st["rf"][k] / max(st["rfm"], 1e-6)
            out[f"rs_{k}"] = st["rs"][k] / max(st["rsm"], 1e-6)
            out[f"rl_{k}"] = st["rl"][k] / max(st["rlm"], 1e-6)
            out[f"rsea_{k}"] = (st["ssum"][k] / max(st["smin"], 1e-6)) if st["season"] == season and st["smin"] > 60 else out[f"rs_{k}"]
    return out


def team_rows(state: dict, members: list[int], team: int, opp: int, is_home: int, start_utc: pd.Timestamp, season: int, exp_margin: float, out_set: set[int]) -> pd.DataFrame:
    """One row per roster player: his features if he plays and `out_set` (minus him) sits - the same definitions minutes.build() uses."""
    ps = state["pstate"]
    base = {p: ps[p]["slow"] if p in ps else COLD for p in members}
    lg = state["last_game"].get(team)
    rest = (start_utc - lg).total_seconds() / 86400.0 if lg is not None else 7.0
    recent = [x for x in state["team_hist"].get(team, []) if (start_utc - x).total_seconds() <= 4 * 86400.0]
    opp_a = state["allowed"].get(opp, {})
    own_pace, opp_pace = state["pace"].get(team), state["pace"].get(opp)
    rows = []
    for p in members:
        out = out_set - {p}
        avail = [q for q in members if q not in out]
        st = ps.get(p)
        rows.append(
            {
                "player_id": p, "is_home": is_home, **_base_feats(st, season),
                "vacated": sum(base[q] for q in out if base[q] >= ROT), "avail_rot": sum(1 for q in avail if base[q] >= ROT),
                "n_out_rot": sum(1 for q in out if base[q] >= ROT), "rank_today": 1 + sum(1 for q in avail if q != p and base[q] > base[p]),
                "tgno": state["tgcount"].get((team, season), 0) + 1, "rest": rest, "b2b": 1 if rest < 1.5 else 0, "games_4d": len(recent), "exp_margin": exp_margin, "abs_margin": abs(exp_margin),
                **_rates(st, season),
                **{f"vac_{k}": sum(ps[q]["rs"][k] for q in out if q in ps and base[q] >= ROT) for k in VAC_KEYS},
                **{f"opp_{k}": opp_a.get(k, np.nan) for k in STATS},
                "own_pace": own_pace if own_pace is not None else np.nan, "opp_pace": opp_pace if opp_pace is not None else np.nan,
            }
        )
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ scenarios

def scenarios(p_play: dict[int, float], base: dict[int, float], rng: np.random.Generator) -> list[tuple[set[int], float]]:
    """(out-set, weight). Certain players are fixed (p >= .97 plays, p <= .03 sits); the uncertain are enumerated or sampled."""
    fixed_out = {p for p, v in p_play.items() if v <= 0.03}
    unc = [(p, v) for p, v in p_play.items() if 0.03 < v < 0.97 and base.get(p, COLD) >= 4.0]
    if not unc:
        return [(set(fixed_out), 1.0)]
    if len(unc) <= MAX_ENUM:
        out = []
        for combo in itertools.product([0, 1], repeat=len(unc)):  # 1 = plays
            w = 1.0
            sit = set(fixed_out)
            for (p, v), c in zip(unc, combo):
                w *= v if c else 1 - v
                if not c:
                    sit.add(p)
            out.append((sit, w))
        return out
    draws: dict[frozenset, int] = {}
    for _ in range(N_SAMPLE):
        sit = set(fixed_out) | {p for p, v in unc if rng.random() > v}
        draws[frozenset(sit)] = draws.get(frozenset(sit), 0) + 1
    return [(set(k), c / N_SAMPLE) for k, c in draws.items()]


# ------------------------------------------------------------------ projection for one team

def _corr() -> tuple[list[str], np.ndarray]:
    d = json.loads((MODELS / "nba_stat_corr.json").read_text())
    return d["stats"], np.linalg.cholesky(np.array(d["corr"]))


def joint_milestones(mixes: dict[str, np.ndarray], n: int, rng: np.random.Generator, draws: int = 4000) -> tuple[np.ndarray, np.ndarray]:
    """P(double-double), P(triple-double) per player: stats drawn together through the Gaussian copula (simcorr.py) from each player's
    scenario-mixed distributions. Points, rebounds, assists, steals and blocks count."""
    from scipy.stats import norm

    names, chol = _corr()
    dd = np.zeros(n)
    td = np.zeros(n)
    for i in range(n):
        z = rng.standard_normal((draws, len(names))) @ chol.T
        u = norm.cdf(z)
        vals = {nm: np.minimum(np.searchsorted(mixes[nm][i], u[:, k], side="left"), 60) for k, nm in enumerate(names) if nm in mixes}
        tens = sum((vals[nm] >= 10).astype(int) for nm in ("pts", "reb", "ast", "stl", "blk"))
        dd[i], td[i] = float((tens >= 2).mean()), float((tens >= 3).mean())
    return dd, td


def rotation_minutes(m: np.ndarray, avail: np.ndarray, total: float = 240.0) -> np.ndarray:
    """Expected minutes actually played by each player (0 if unavailable) so that the team's expected minutes are exactly `total`.

    The minutes model predicts minutes GIVEN a player gets into the game, so a roster's predictions add up to more than a game has: the
    deep bench each look like ten minutes when in truth only a few of them play at all. The rotation is stretched out the way a coach
    does it: players above a cut-off minutes level play as predicted, and below it the chance of playing falls off quickly
    (weight = (minutes / cut-off)^2, capped at 1), with the cut-off set so everything sums to 240. If the roster is so thin that even
    everyone playing falls short, the available players' minutes are scaled up instead."""
    e = np.zeros(len(m))
    a = np.where(avail)[0]
    if len(a) == 0:
        return e
    ma = np.maximum(m[a], 0.5)
    if ma.sum() <= total:
        e[a] = ma * (total / ma.sum())
        return e
    lo, hi = 0.5, 60.0
    for _ in range(50):
        mid = (lo + hi) / 2
        f = (np.minimum(1.0, (ma / mid) ** 2) * ma).sum()
        lo, hi = (mid, hi) if f > total else (lo, mid)
    cut = (lo + hi) / 2
    e[a] = np.minimum(1.0, (ma / cut) ** 2) * ma
    return e


BASE_STATS = ["pts", "reb", "ast", "tpm", "stl", "blk", "tov"]


def project_team(
    state: dict, mbundle: dict, pbundle: dict, members: list[int], p_play: dict[int, float], ctx: dict, rng: np.random.Generator,
    rating: dict[int, tuple[float, float]] | None = None, stats: bool = True, targets: dict[str, float] | None = None,
) -> tuple[pd.DataFrame, dict]:
    """Per-player projections (scenario-blended) and the team's strength under each scenario.

    `rating` (player -> (offence, points-allowed) per 100) gives strength = {"w": scenario weights, "off", "de"}: the minutes-weighted
    sums of the five on the floor. With stats=False only minutes and strength are computed (the first pass, before the game model
    exists). `targets` ({"pts": team points, "reb": ..}) rescale each stat's player means so a team's expected stat line adds up to
    its game projection (the factor is returned in strength["scale"])."""
    base = {p: state["pstate"][p]["slow"] if p in state["pstate"] else COLD for p in members}
    scs = scenarios(p_play, base, rng)
    frames, weights = [], []
    for out_set, w in scs:
        df = team_rows(state, members, ctx["team"], ctx["opp"], ctx["is_home"], ctx["start"], ctx["season"], ctx["exp_margin"], out_set)
        df["sc"] = len(frames)
        frames.append(df)
        weights.append(w)
    big = pd.concat(frames, ignore_index=True)
    m = mbundle["models"]
    for col, key in (("pm_mean", "mean"), ("pm_q10", "q10"), ("pm_q50", "q50"), ("pm_q90", "q90")):
        big[col] = m[key].predict(big[XCOLS])
    S, n = len(scs), len(members)
    W = np.array(weights)
    wsum = W.sum()
    Wn = W / wsum
    avail = np.array([[p not in out_set for p in members] for out_set, _ in scs])  # (S, n)
    pm = big["pm_mean"].to_numpy().reshape(S, n)
    emin = np.vstack([rotation_minutes(pm[k], avail[k]) for k in range(S)])  # expected minutes actually played, per scenario
    ratio = np.where(avail & (pm > 0), emin / np.maximum(pm, 1e-6), 0.0)  # his share of the minutes the model gave him
    out = pd.DataFrame({"player_id": members})
    strength = {"w": Wn, "off": np.zeros(S), "de": np.zeros(S), "scale": {}}
    if rating is not None:
        offv = np.array([rating.get(p, (0.0, 0.0))[0] for p in members])
        dev = np.array([rating.get(p, (0.0, 0.0))[1] for p in members])
        for k in range(S):
            w5 = emin[k] / max(emin[k].sum(), 1e-6) * 5.0
            strength["off"][k], strength["de"][k] = float((w5 * offv).sum()), float((w5 * dev).sum())

    def avg(v):  # scenario-weighted mean per player of an (S, n) array
        return (v * Wn[:, None]).sum(0)

    out["min_mean"] = avg(pm)
    out["min_q10"] = avg(big["pm_q10"].to_numpy().reshape(S, n))
    out["min_q90"] = avg(big["pm_q90"].to_numpy().reshape(S, n))
    out["exp_min"] = avg(emin)
    avail_p = avg(avail.astype(float))
    out["p_rot"] = np.where(avail_p > 1e-6, avg(np.minimum(ratio, 1.0) * avail) / np.maximum(avail_p, 1e-6), 0.0)  # chance he gets into the game when healthy
    out["base_min"] = [base[p] for p in members]
    out["n_prior"] = [int(state["pstate"][p]["n"]) if p in state["pstate"] else 0 for p in members]  # NBA games behind his baseline (0 = no history: a rookie or newcomer)
    if not stats:
        out["stats"] = [{} for _ in range(n)]
        return out, strength

    # stat projections: model mean per scenario -> (team reconciliation) -> outcome distribution (calibrated tables) -> scenario mixture
    ks = np.arange(0, 61)
    mu_all: dict[str, np.ndarray] = {}
    for name in BASE_STATS:
        X = feature_frame(big, pbundle["targets"][name], name)
        mu_all[name] = pbundle["models"][name].predict(X).reshape(S, n)
    shift = {name: np.zeros((S, n)) for name in pbundle["targets"]}
    for name in BASE_STATS:
        exp_i = avg(mu_all[name] * ratio)
        total = float(exp_i.sum())
        c = 1.0
        if targets and name in targets and total > 1e-6:
            lim = (0.85, 1.15) if name == "pts" else (0.88, 1.12)
            c = float(np.clip(targets[name] / total, *lim))
        strength["scale"][name] = round(c, 3)
        for combo, comps in pbundle["targets"].items():
            if len(comps) > 1 and name in comps:
                shift[combo] += mu_all[name] * (c - 1.0)
        mu_all[name] = mu_all[name] * c
    stat_out: dict[str, list] = {}
    mixes: dict[str, np.ndarray] = {}
    for name, comps in pbundle["targets"].items():
        if name in BASE_STATS:
            mu2 = mu_all[name]
        else:
            X = feature_frame(big, comps, name)
            mu2 = pbundle["models"][name].predict(X).reshape(S, n) + shift[name]
        dist = pbundle["dists"][name]
        kk = np.clip(ks, 0, len(dist.vals) - 1)
        cdf = dist.cdf_at(mu2.reshape(-1)[:, None], kk[None, :]).reshape(S, n, -1)  # P(stat <= k)
        mix = (cdf * Wn[:, None, None]).sum(0)  # (n, K)
        mean = avg(mu2)
        exp_i = avg(mu2 * ratio)  # unconditional: weighted by whether he is available and in the rotation
        mixes[name] = mix
        res = []
        for i in range(n):
            c = mix[i]
            med = int(np.argmax(c >= 0.5))
            ge = 1.0 - np.concatenate([[0.0], c[:-1]])  # P(stat >= k)
            lo = int(np.argmax(ge <= 0.985)) if (ge <= 0.985).any() else 0
            hi_idx = np.where(ge >= 0.015)[0]
            hi = int(hi_idx.max()) if len(hi_idx) else lo
            hi = min(hi, lo + 45)
            res.append({"mean": round(float(mean[i]), 2), "e": round(float(exp_i[i]), 2), "median": med, "k0": lo, "ge": [round(float(x), 3) for x in ge[lo : hi + 1]]})
        stat_out[name] = res
    dd, td = joint_milestones(mixes, n, rng)
    out["stats"] = [{**{k: stat_out[k][i] for k in stat_out}, "_joint": {"dd": round(float(dd[i]), 3), "td": round(float(td[i]), 3)}} for i in range(n)]
    return out, strength


# ------------------------------------------------------------------ the news move

def news_swing(state: dict, members: list[int], p_play: dict[int, float], net: dict[int, float], coef: dict) -> tuple[float, float, list[dict]]:
    """(rating part S1, minutes part S0, contributors) for the FRESH-news players of one team; same definitions as reprice.py."""
    s1 = s0 = 0.0
    who = []
    for p in members:
        pl = p_play.get(p, 1.0)
        st = state["pstate"].get(p)
        if pl >= 1.0 or st is None or st["slow"] < 6:
            continue
        if int(st["team_games_since"]) >= 1:  # missed his team's last game: already priced
            continue
        share = min(st["slow"], 40.0) / 48.0
        r = net.get(p, 0.0)
        s1 += (1 - pl) * share * r
        s0 += (1 - pl) * share
        who.append({"player_id": p, "p_play": round(pl, 3), "share": round(share, 3), "net": round(r, 2), "effect": round(-(1 - pl) * share * (coef["c1"] * r + coef["c0"]), 2)})
    return s1, s0, sorted(who, key=lambda x: x["effect"])


def news_move(sh: tuple[float, float], sa: tuple[float, float], coef: dict) -> float:
    """Expected move of the home margin from fresh news: positive = the news favours home (the away side lost more)."""
    return coef["c1"] * (sa[0] - sh[0]) + coef["c0"] * (sa[1] - sh[1])


# ------------------------------------------------------------------ check: replay a finished game

def check(event_id: int) -> None:
    """Rebuild one finished game's features with the live code (state before the game, actual non-players as the out-set) and compare
    them with the stored feature table."""
    feats = pd.read_csv(FEATURES_OUT)
    g = feats[feats["event_id"] == event_id]
    state = build_state(emit=False, stop_at=event_id)
    season = int(g["season"].iloc[0])
    start = pd.Timestamp(g["start_utc"].iloc[0])
    start = start if start.tzinfo else start.tz_localize("UTC")
    worst = {}
    for team, tg in g.groupby("team_id"):
        opp = int(g[g["team_id"] != team]["team_id"].iloc[0]) if g["team_id"].nunique() > 1 else 0
        members = [int(p) for p in tg["player_id"]]
        out_set = {int(p) for p, pl in zip(tg["player_id"], tg["played"]) if pl == 0}
        mine = team_rows(state, members, int(team), opp, int(tg["is_home"].iloc[0]), start, season, float(tg["exp_margin"].iloc[0]), out_set)
        # rows for non-players in the stored table have the same definitions (vacated excludes himself)
        both = mine.merge(tg[tg["played"] == 1], on="player_id", suffixes=("_l", ""))  # rows are "if he plays": compare players who did
        for c in XCOLS + [f"rf_{k}" for k in STATS] + [f"rs_{k}" for k in STATS] + [f"vac_{k}" for k in VAC_KEYS] + [f"opp_{k}" for k in STATS] + ["own_pace", "opp_pace"]:
            a, b = both[f"{c}_l"].to_numpy(float) if f"{c}_l" in both else both[c].to_numpy(float), both[c].to_numpy(float)
            if f"{c}_l" not in both:
                continue
            d = np.nanmax(np.abs(a - b)) if np.isfinite(a - b).any() else 0.0
            worst[c] = max(worst.get(c, 0.0), float(d))
    bad = {k: round(v, 4) for k, v in worst.items() if v > 1e-6}
    print(f"event {event_id}: {len(worst)} features compared; mismatches > 1e-6: {bad if bad else 'none'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["check"])
    ap.add_argument("arg", nargs="?", type=int)
    a = ap.parse_args()
    if a.what == "check":
        check(a.arg)


if __name__ == "__main__":
    main()
