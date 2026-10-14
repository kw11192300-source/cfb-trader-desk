"""
Preseason team ratings: what a team should look like BEFORE it has played, from its roster.

For a team T in season S the model knows (all of it available in October):
  - T's final adjusted offence / defence / tempo last season                     (ratings.py, no prior)
  - which players are on its roster now, and what each did last season - for players returning to T, and for transfers who
    arrive from other teams, using their box-score line and share of floor time there                     (bpm.py value model)
  - how much of the floor time last season walked out of the door, and how experienced the group is

and projects its season-end offence and defence with a ridge regression trained on earlier seasons (walk-forward: season S is
always predicted from models fit on seasons before it). The baseline it has to beat is "last season's rating, carried over".

Roster for a historical season is taken from who played for the team that year (a small leak: it includes late arrivals and
excludes players who never took the floor); for the coming season the same table comes from ESPN's current rosters.

Usage:
    python -m cbb_model.preseason evaluate
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from .bpm import PLAYER_SEASONS_OUT, STATS, TARGETS_OUT, per40, ridge, team_features

FEATURES = ["prior_off", "prior_de", "prior_tempo", "proj_off", "proj_de", "unfilled", "ret_share", "trans_share", "exp_w", "n_trans", "trans_lvl"]


def value_weights(ps40: pd.DataFrame, tgt: pd.DataFrame, upto_season: int) -> dict[str, np.ndarray]:
    """Box-score value weights (offence and defence) fit on team-seasons strictly before `upto_season`."""
    tf = team_features(ps40[ps40["season"] < upto_season])
    d = tf.merge(tgt[tgt["games"] >= 15], on=["season", "team_id"])
    xs = [f"x_{s}" for s in STATS]
    X = d[xs].to_numpy()
    return {"off": ridge(X, d["off"].to_numpy(), 5.0), "de": ridge(X, d["de"].to_numpy(), 5.0)}


def season_table(
    ps40: pd.DataFrame,
    tgt: pd.DataFrame,
    S: int,
    weights: dict[str, np.ndarray],
    roster: pd.DataFrame | None = None,
    extras: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """One row per team with the preseason features for season S. `extras` adds players who are not in last season's data -
    internationals, pros, anyone entered by hand - as (team_id, f, v_off, v_de): their floor share and value on the same
    scale as the box-score player values."""
    xs = [f"x_{s}" for s in STATS]
    last = ps40[ps40["season"] == S - 1].copy()
    # per-player value (without the intercept: the regression intercept is the "average floor" constant)
    last["v_off"] = last[xs].to_numpy() @ weights["off"][1:]
    last["v_de"] = last[xs].to_numpy() @ weights["de"][1:]
    # centre by the floor-time-weighted league mean so an average player is 0
    mo = np.average(last["v_off"], weights=last["f"])
    md = np.average(last["v_de"], weights=last["f"])
    last["v_off"] -= mo
    last["v_de"] -= md
    prev = last.set_index("player_id")[["team_id", "f", "v_off", "v_de", "min"]].rename(columns={"team_id": "prev_team", "min": "min_prev"})
    prev = prev[~prev.index.duplicated(keep="first")]

    if roster is not None:  # the coming season: ESPN's current rosters (team_id, player_id), floor time unknown
        cur = roster[["team_id", "player_id"]].copy()
        cur["min"] = 1.0
    else:
        cur = ps40[ps40["season"] == S][["team_id", "player_id", "min"]].copy()
    cur = cur.join(prev, on="player_id", how="left")
    # how many earlier seasons each current player has on record (experience proxy)
    seen = ps40[ps40["season"] < S].groupby("player_id")["season"].nunique()
    cur["n_prev"] = cur["player_id"].map(seen).fillna(0)

    # a transfer's old numbers were put up in a different context: the learned weight on the quality gap between the two teams
    # (how much better or worse the new team was last season) is what turns a mid-major line into a high-major expectation
    last_net = (tgt[tgt["season"] == S - 1].set_index("team_id")["off"] - tgt[tgt["season"] == S - 1].set_index("team_id")["de"]).to_dict()
    ex = extras if extras is not None else pd.DataFrame(columns=["team_id", "f", "v_off", "v_de"])

    rows = []
    for t, g in cur.groupby("team_id"):
        known = g[g["f"].notna()]
        ret = known[known["prev_team"] == t]
        trans = known[known["prev_team"] != t]
        f_ret, f_tr = ret["f"].sum(), trans["f"].sum()
        ex_t = ex[ex["team_id"] == t]
        lvl = float(sum(f * (last_net.get(t, 0.0) - last_net.get(pt, last_net.get(t, 0.0))) for f, pt in zip(trans["f"], trans["prev_team"])))
        f_ex = float(ex_t["f"].sum())
        # floor share of last season's roster that is back / new, plus the value they bring
        rows.append(
            {
                "season": S, "team_id": t,
                "proj_off": float((known["f"] * known["v_off"]).sum() + (ex_t["f"] * ex_t["v_off"]).sum()),
                "proj_de": float((known["f"] * known["v_de"]).sum() + (ex_t["f"] * ex_t["v_de"]).sum()),
                "ret_share": float(f_ret / 5.0), "trans_share": float((f_tr + f_ex) / 5.0),
                "unfilled": float(max(0.0, 5.0 - (f_ret + f_tr + f_ex)) / 5.0),
                "n_trans": float(len(trans) + len(ex_t)),
                "trans_lvl": lvl,
                "roster_listed": float(len(g) + len(ex_t)),
                "exp_w": float(np.average(g["n_prev"], weights=g["min"].clip(lower=1))),
            }
        )
    out = pd.DataFrame(rows)
    p = tgt[tgt["season"] == S - 1][["team_id", "off", "de", "tempo"]].rename(columns={"off": "prior_off", "de": "prior_de", "tempo": "prior_tempo"})
    return out.merge(p, on="team_id", how="left")


def preseason_ratings(
    S: int,
    ps40: pd.DataFrame | None = None,
    tgt: pd.DataFrame | None = None,
    roster: pd.DataFrame | None = None,
    extras: pd.DataFrame | None = None,
):
    """A ratings.Ratings holding the roster-based projection of season S's end-of-season offence/defence/tempo for every team
    that played in S-1, from models trained on seasons before S. Needs at least two earlier seasons of history."""
    from .ratings import Ratings

    if ps40 is None:
        ps40 = per40(pd.read_csv(PLAYER_SEASONS_OUT))
    if tgt is None:
        tgt = pd.read_csv(TARGETS_OUT)
    train = []
    for s in range(2019, S):
        t = season_table(ps40, tgt, s, value_weights(ps40, tgt, s)).merge(tgt[["season", "team_id", "off", "de", "tempo", "games"]], on=["season", "team_id"])
        train.append(t[(t["games"] >= 15) & t["prior_off"].notna()])
    if len(train) < 2:
        return None
    d = pd.concat(train)
    cur = season_table(ps40, tgt, S, value_weights(ps40, tgt, S), roster=roster, extras=extras)
    cur = cur[cur["prior_off"].notna()]
    # ESPN rosters fill in late: a team listing fewer than 11 players has not loaded its incoming transfers/signees yet, so its
    # missing floor time is assumed to be filled by a typical newcomer class instead of read as "nobody left to play"
    typical_unfilled = float(d["unfilled"].mean())
    incomplete = (cur["roster_listed"] < 11) if roster is not None else pd.Series(False, index=cur.index)
    cur.loc[incomplete, "unfilled"] = typical_unfilled
    cur.loc[incomplete, "trans_lvl"] = 0.0
    X, Xc = d[FEATURES].to_numpy(), cur[FEATURES].to_numpy()
    out = {}
    for key in ("off", "de", "tempo"):
        b = ridge(X, d[key].to_numpy(), 3.0)
        out[key] = np.c_[np.ones(len(Xc)), Xc] @ b
    ids = cur["team_id"].astype(int).tolist()
    center = {k: float(np.mean(v)) for k, v in out.items()}
    return Ratings(
        off={t: float(o - center["off"]) for t, o in zip(ids, out["off"])},
        de={t: float(o - center["de"]) for t, o in zip(ids, out["de"])},
        tempo={t: float(o - center["tempo"]) for t, o in zip(ids, out["tempo"])},
        mu=0.0, hca=0.0, mu_t=0.0, n_games={t: 0 for t in ids},
    )


def current_rosters(season: int) -> pd.DataFrame:
    """Every player on ESPN's current roster for each D1 team (team_id, player_id, name, class, height), plus head coach."""
    from .ingest import DATA_DIR, RAW_ROSTERS, read_gz

    conf = pd.read_csv(DATA_DIR / "conferences.csv")
    d1 = set(conf[conf["season"] == conf["season"].max()]["team_id"].astype(int))
    rows = []
    for t in sorted(d1):
        p = RAW_ROSTERS / str(season) / f"{t}.json.gz"
        if not p.exists():
            continue
        r = read_gz(p)
        coach = r.get("coach") or []
        coach_name = f"{coach[0].get('firstName', '')} {coach[0].get('lastName', '')}".strip() if coach else None
        for a in r.get("athletes", []):
            try:
                pid = int(a["id"])
            except (TypeError, ValueError):
                continue
            rows.append({"team_id": t, "player_id": pid, "name": a.get("name"), "class": a.get("class"), "height": a.get("height"), "coach": coach_name})
    return pd.DataFrame(rows)


def evaluate() -> None:
    ps = pd.read_csv(PLAYER_SEASONS_OUT)
    tgt = pd.read_csv(TARGETS_OUT)
    ps40 = per40(ps)
    tables = []
    for S in range(2020, 2026):
        w = value_weights(ps40, tgt, S)
        t = season_table(ps40, tgt, S, w)
        tables.append(t.merge(tgt[["season", "team_id", "off", "de", "tempo", "games"]], on=["season", "team_id"]))
    d = pd.concat(tables)
    d = d[(d["games"] >= 15) & d["prior_off"].notna()]
    print(f"{len(d):,} team-seasons with a prior season, 2020-2025")
    for target, prior in (("off", "prior_off"), ("de", "prior_de"), ("tempo", "prior_tempo")):
        y = d[target].to_numpy()
        carry = d[prior].to_numpy()
        feats = [f for f in FEATURES]
        X = d[feats].to_numpy()
        pred = np.zeros(len(d))
        for S in sorted(d["season"].unique()):
            m = (d["season"] == S).to_numpy()
            b = ridge(X[~m], y[~m], lam=3.0)
            pred[m] = np.c_[np.ones(m.sum()), X[m]] @ b
        sse = lambda p: float(np.mean((y - p) ** 2))  # noqa: E731
        # best simple carry-over: scaled prior
        k = float(np.dot(carry - carry.mean(), y - y.mean()) / np.dot(carry - carry.mean(), carry - carry.mean()))
        print(f"  {target}: RMSE  carry-over x1.0 {np.sqrt(sse(carry)):.2f} | best scaled carry (x{k:.2f}) {np.sqrt(sse(k * (carry - carry.mean()) + y.mean())):.2f} | roster model {np.sqrt(sse(pred)):.2f}   (sd {y.std():.2f})")
    # which features matter (full-sample fit, standardised)
    X = d[FEATURES].to_numpy()
    sdv = X.std(axis=0)
    b = ridge((X - X.mean(axis=0)) / sdv, d["off"].to_numpy(), 3.0)[1:]
    print("  offence coefficients (per 1 sd):", {f: round(float(c), 2) for f, c in zip(FEATURES, b)})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["evaluate"])
    ap.parse_args()
    evaluate()


if __name__ == "__main__":
    main()
