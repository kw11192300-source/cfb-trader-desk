"""
The player ratings table behind the Players page and each team's roster: for everyone on a Division I roster (ESPN's list plus
hand-entered additions) last season's box-score line, a value rating, and a projection for the coming season.

Value = the box-score value model (bpm.py): points per 100 possessions better than an average D1 player, offence and defence,
per full floor share. The projection is what that value should be NEXT season, learned from every player who stayed or
moved in the past:
    stayed:       value_next = a + b * value_last
    transferred:  value_next = a + b * value_last + c * (new team's level - old team's level)
so a mid-major star arriving at a high-major gets discounted by the learned amount, and a high-major role player dropping
down is boosted. Newcomers with no D1 history (freshmen, internationals, pros) get the first-year average, or a number you
enter in roster_overrides.csv.

Usage:
    python -m cbb_model.players_table --season 2026 [--dry-run]
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd

from .bpm import PLAYER_SEASONS_OUT, STATS, TARGETS_OUT, per40
from .ingest import DATA_DIR
from .overrides import apply as apply_overrides, newcomer_values
from .preseason import current_rosters, value_weights


def player_values(ps40: pd.DataFrame, weights: dict) -> pd.DataFrame:
    """v_off, v_de, v_net per player-season, each season centred on its floor-weighted league mean."""
    xs = [f"x_{s}" for s in STATS]
    out = ps40.copy()
    X = out[xs].to_numpy()
    if "mu_x" in weights:  # player-level weights are on standardised features
        X = (X - weights["mu_x"]) / weights["sd_x"]
    out["v_off"] = X @ weights["off"][1:]
    out["v_de"] = X @ weights["de"][1:]
    for s in out["season"].unique():
        m = out["season"] == s
        out.loc[m, "v_off"] -= np.average(out.loc[m, "v_off"], weights=out.loc[m, "f"])
        out.loc[m, "v_de"] -= np.average(out.loc[m, "v_de"], weights=out.loc[m, "f"])
    out["v_net"] = out["v_off"] - out["v_de"]
    return out


def translation_models(pv: pd.DataFrame, tgt: pd.DataFrame, upto: int) -> dict:
    """OLS of next season's value on this season's (stayers) and also on the level change (movers), 2019..upto."""
    level = (tgt["off"] - tgt["de"]).groupby([tgt["season"], tgt["team_id"]]).first()
    rows = []
    for s in range(2019, upto + 1):
        a = pv[pv["season"] == s - 1].drop_duplicates("player_id").set_index("player_id")
        b = pv[pv["season"] == s].drop_duplicates("player_id").set_index("player_id")
        j = a.join(b, lsuffix="_p", rsuffix="_c", how="inner")
        j = j[(j["min_p"] >= 250) & (j["min_c"] >= 250)]
        for pid, r in j.iterrows():
            moved = r["team_id_p"] != r["team_id_c"]
            dl = level.get((s - 1, r["team_id_c"]), np.nan) - level.get((s - 1, r["team_id_p"]), np.nan)
            rows.append({"moved": moved, "v_p": r["v_net_p"], "v_c": r["v_net_c"], "dl": dl, "w": min(r["min_p"], r["min_c"])})
    d = pd.DataFrame(rows)
    models = {}
    for moved in (False, True):
        g = d[d["moved"] == moved].dropna()
        X = np.c_[np.ones(len(g)), g["v_p"]] if not moved else np.c_[np.ones(len(g)), g["v_p"], g["dl"]]
        w = np.sqrt(g["w"].to_numpy())
        beta = np.linalg.lstsq(X * w[:, None], g["v_c"].to_numpy() * w, rcond=None)[0]
        pred = X @ beta
        r2 = 1 - np.sum((g["v_c"] - pred) ** 2) / np.sum((g["v_c"] - g["v_c"].mean()) ** 2)
        models["move" if moved else "stay"] = beta
        print(f"  {'transferred' if moved else 'stayed':>11}: n={len(g):,} R2 {r2:.2f} coefficients {np.round(beta, 3)}", flush=True)
    return models


def build_rows(season: int) -> list[dict]:
    ps = pd.read_csv(PLAYER_SEASONS_OUT)
    tgt = pd.read_csv(TARGETS_OUT)
    ps40 = per40(ps)
    weights = value_weights(ps40, tgt, season)
    pv = player_values(ps40, weights)
    # last season's players with lineup evidence: replace the box-score estimate with the posterior (box prior + on/off data)
    post_path = DATA_DIR / "player_ratings_v2.csv"
    post = pd.read_csv(post_path).set_index("player_id") if post_path.exists() else pd.DataFrame()
    if len(post):
        m = (pv["season"] == season - 1) & pv["player_id"].isin(post.index)
        pv.loc[m, "v_off"] = pv.loc[m, "player_id"].map(post["off"]).to_numpy()
        pv.loc[m, "v_de"] = pv.loc[m, "player_id"].map(post["def"]).to_numpy()
        pv.loc[m, "v_net"] = pv.loc[m, "v_off"] - pv.loc[m, "v_de"]
        pv["lineup_poss"] = pv["player_id"].map(post["poss"]).where(pv["season"] == season - 1)
    print("translation models:", flush=True)
    models = translation_models(pv, tgt, season - 1)

    teams = pd.read_csv(DATA_DIR / "teams.csv").drop_duplicates("id").set_index("id")["name"]
    names_csv = DATA_DIR / "team_names.csv"
    school = pd.read_csv(names_csv).set_index("id")["school"].to_dict() if names_csv.exists() else {}
    roster = current_rosters(season)
    roster, extras, _ = apply_overrides(roster, ps40, teams, weights, season - 1)
    from .recruits import recruit_extras

    roster, extras, _ = recruit_extras(roster, extras, season, set(ps40[ps40["season"] == season - 1]["player_id"]))
    level = (tgt[tgt["season"] == season - 1].set_index("team_id")["off"] - tgt[tgt["season"] == season - 1].set_index("team_id")["de"]).to_dict()
    nv_o, nv_d = newcomer_values(ps40, weights, range(max(int(ps40["season"].min()) + 1, season - 4), season))
    newcomer_net = nv_o - nv_d

    last = pv[pv["season"] == season - 1].drop_duplicates("player_id").set_index("player_id")
    conf_year = pd.read_csv(DATA_DIR / "conferences.csv")
    d1 = set(conf_year[conf_year["season"] == conf_year["season"].max()]["team_id"].astype(int))

    rows: list[dict] = []
    for r in roster.itertuples():
        if int(r.team_id) not in d1:
            continue
        has = r.player_id in last.index
        base = {"season": season, "kind": "preseason", "player_id": int(r.player_id), "name": r.name, "team_id": int(r.team_id), "team": teams.get(int(r.team_id), str(r.team_id))}
        stats: dict = {"class": getattr(r, "class_", None) if hasattr(r, "class_") else None, "school": school.get(int(r.team_id))}
        # itertuples renames the reserved word "class"; read it from the frame instead
        stats["class"] = roster.loc[r.Index, "class"] if "class" in roster.columns else None
        stats["height"] = roster.loc[r.Index, "height"] if "height" in roster.columns else None
        if has:
            p = last.loc[r.player_id]
            g, mn = max(float(p["g"]), 1.0), max(float(p["min"]), 1.0)
            moved = int(p["team_id"]) != int(r.team_id)
            dl = level.get(int(r.team_id), 0.0) - level.get(int(p["team_id"]), level.get(int(r.team_id), 0.0))
            b = models["move"] if moved else models["stay"]
            proj = float(b[0] + b[1] * p["v_net"] + (b[2] * dl if moved else 0.0))
            fga, fta = float(p["fga"]), float(p["fta"])
            stats.update(
                {
                    "role": "transfer" if moved else "returner",
                    "prev_team": (school.get(int(p["team_id"])) or teams.get(int(p["team_id"]))) if moved else None,
                    "pos": p.get("pos"), "g": int(g), "mpg": round(mn / g, 1), "ppg": round(float(p["pts"]) / g, 1),
                    "rpg": round((float(p["oreb"]) + float(p["dreb"])) / g, 1), "apg": round(float(p["ast"]) / g, 1),
                    "spg": round(float(p["stl"]) / g, 1), "bpg": round(float(p["blk"]) / g, 1), "tpg": round(float(p["tov"]) / g, 1),
                    # percentages from a handful of shots mean nothing: shown only past a minimum number of attempts
                    "fg_pct": round(float(p["fgm"]) / fga, 3) if fga >= 15 else None,
                    "tp_pct": round(float(p["tpm"]) / float(p["tpa"]), 3) if float(p["tpa"]) >= 15 else None,
                    "ft_pct": round(float(p["ftm"]) / fta, 3) if fta >= 15 else None,
                    "ts_pct": round(float(p["pts"]) / (2 * (fga + 0.44 * fta)), 3) if fga + 0.44 * fta >= 25 else None,
                    "last_net": round(float(p["v_net"]), 2), "last_off": round(float(p["v_off"]), 2), "last_def": round(float(p["v_de"]), 2),
                    "lineup_poss": None if pd.isna(p.get("lineup_poss", np.nan)) else int(p["lineup_poss"]),
                    "last_floor": round(float(p["f"]) * 20.0, 1),  # % of team minutes (f sums to 5)
                    "proj_net": round(proj, 2), "proj_floor": round(float(p["f"]) * (0.92 if moved else 1.0) * 20.0, 1),
                }
            )
        else:
            stats.update({"role": "newcomer", "proj_net": round(newcomer_net, 2), "proj_floor": 5.0})
        rows.append({**base, "stats": stats})

    # hand-entered players with no D1 history
    for i, e in enumerate(extras.itertuples()):
        rows.append(
            {
                "season": season, "kind": "preseason", "player_id": -(int(e.team_id) * 100 + i + 1), "name": e.name, "team_id": int(e.team_id),
                "team": teams.get(int(e.team_id), str(e.team_id)),
                "stats": {"school": school.get(int(e.team_id)), "recruit_rank": (None if pd.isna(getattr(e, "rank", np.nan)) else int(e.rank)),
                          "role": {"intl": "international", "pro": "pro", "fr": "freshman", "jc": "juco"}.get(e.kind, "newcomer"),
                          "proj_net": round(float(e.v_off - e.v_de), 2), "proj_floor": round(float(e.f) * 20.0, 1), "class": None, "height": None},
            }
        )
    # impact = projected value x projected floor share (so a great bench player does not outrank a great starter)
    for r in rows:
        s = r["stats"]
        s["impact"] = round(float(s["proj_net"]) * float(s["proj_floor"]) / 20.0, 2)
        s["proj_mpg"] = round(float(s["proj_floor"]) / 100.0 * 200.0, 1)  # share of the team's 200 minutes -> minutes a game
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    rows = build_rows(a.season)
    print(f"{len(rows):,} players on D1 rosters")
    top = sorted(rows, key=lambda r: -r["stats"]["impact"])[:12]
    for r in top:
        s = r["stats"]
        print(f"  {r['name']:<24} {r['team']:<26} {s.get('role'):<10} proj {s['proj_net']:+5.1f} impact {s['impact']:+5.2f} last {s.get('last_net')} ppg {s.get('ppg')} prev {s.get('prev_team')}")
    if a.dry_run:
        (DATA_DIR / "last_publish_players.json").write_text(json.dumps(rows, default=str))
        print("dry run - nothing written")
        return
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    now = pd.Timestamp.now(tz="UTC").isoformat()
    conf_df = pd.read_csv(DATA_DIR / "conferences.csv")
    conf_now = conf_df[conf_df["season"] == conf_df["season"].max()].set_index("team_id")["conference"].to_dict()
    payload = [{**r, "conference": conf_now.get(r["team_id"]), "impact": r["stats"]["impact"], "updated_at": now} for r in rows]

    def clean(v):  # JSON has no NaN: a missing height or class goes in as null
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, float) and v != v:
            return None
        return v

    payload = [clean(r) for r in payload]
    for i in range(0, len(payload), 300):
        client.table("cbb_player_ratings").upsert(payload[i : i + 300], on_conflict="season,player_id,kind").execute()
    print(f"published {len(payload):,} players")


if __name__ == "__main__":
    main()
