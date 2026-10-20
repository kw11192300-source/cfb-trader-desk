"""
The NBA player value table: every player on a current roster with his lineup-based rating (rapm.py), last season's box line, and
what his absence has cost his team (impact.py) - published to nba_player_ratings for the site's Players page.

    python -m nba_model.players_table             # build and publish (season 2026 = the 2026-27 season, kind 'current')
    python -m nba_model.players_table --dry-run
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
import requests

from .ingest import DATA_DIR
from .parse import PLAYER_GAMES_OUT, TEAM_GAMES_OUT
from .rapm import OUT as RATINGS_OUT

SEASON = 2026  # the season being published for (2026-27); ratings are built from games through the last finished season
HEADERS = {"User-Agent": "Mozilla/5.0 (cfb-trader-desk nba model)"}
SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"


def current_rosters() -> pd.DataFrame:
    teams = requests.get(f"{SITE}/teams", headers=HEADERS, timeout=30).json()["sports"][0]["leagues"][0]["teams"]
    rows = []
    for t in teams:
        tm = t["team"]
        r = requests.get(f"{SITE}/teams/{tm['id']}/roster", headers=HEADERS, timeout=30).json()
        for a in r.get("athletes", []):
            inj = a.get("injuries") or []
            rows.append(
                {
                    "team_id": int(tm["id"]), "team": tm["displayName"], "player_id": int(a["id"]), "roster_name": a.get("displayName"),
                    "pos": (a.get("position") or {}).get("abbreviation"), "age": a.get("age"), "height": a.get("height"), "weight": a.get("weight"),
                    "exp": (a.get("experience") or {}).get("years"), "jersey": a.get("jersey"),
                    "injury": (inj[0].get("status") if inj else None), "injury_note": ((inj[0].get("details") or {}).get("type") if inj and isinstance(inj[0].get("details"), dict) else None),
                }
            )
    return pd.DataFrame(rows)


def box_lines(season: int) -> pd.DataFrame:
    pg = pd.read_csv(PLAYER_GAMES_OUT)
    pg = pg[(pg["season"] == season) & (pg["min"] > 0)]
    g = pg.groupby("player_id").agg(
        gp=("event_id", "nunique"), min=("min", "sum"), pts=("pts", "sum"), reb=("reb", "sum"), ast=("ast", "sum"), stl=("stl", "sum"), blk=("blk", "sum"),
        tov=("tov", "sum"), tpm=("tpm", "sum"), tpa=("tpa", "sum"), fga=("fga", "sum"), fgm=("fgm", "sum"), fta=("fta", "sum"), ftm=("ftm", "sum"),
    )
    g = g[g["min"] >= 50]
    out = pd.DataFrame(index=g.index)
    out["gp"] = g["gp"]
    out["mpg"] = g["min"] / g["gp"]
    for c in ("pts", "reb", "ast", "stl", "blk", "tpm", "tov"):
        out[f"{c}36"] = g[c] / g["min"] * 36.0
    out["ts"] = g["pts"] / (2.0 * (g["fga"] + 0.44 * g["fta"])).clip(lower=1)
    out["tp_pct"] = np.where(g["tpa"] >= 40, g["tpm"] / g["tpa"].clip(lower=1), np.nan)
    out["usage"] = (g["fga"] + 0.44 * g["fta"] + g["tov"]) / g["min"] * 36.0  # possessions used per 36
    return out.reset_index()


def absence_effects() -> pd.DataFrame:
    path = DATA_DIR / "player_impact.csv"
    if not path.exists():
        return pd.DataFrame(columns=["player_id"])
    r = pd.read_csv(path)
    w = r["games_out"] + 5.0
    r = r.assign(w=w)
    g = r.groupby("player_id").apply(
        lambda d: pd.Series(
            {
                "abs_margin": float(np.average(d["margin"], weights=d["w"])), "abs_total": float(np.average(d["total"], weights=d["w"])),
                "abs_pace": float(np.average(d["pace"], weights=d["w"])), "abs_games": int(d["games_out"].sum()),
            }
        )
    )
    return g.reset_index()


def build_rows() -> list[dict]:
    rat = pd.read_csv(RATINGS_OUT)
    ros = current_rosters()
    tg = pd.read_csv(TEAM_GAMES_OUT, usecols=["season"])
    last = int(tg["season"].max())
    if int((tg["season"] == last).sum()) < 400:  # the new season is only a few games old: show last season's box lines until it has 13+ per team
        last -= 1
    box = box_lines(last)
    ab = absence_effects()
    d = ros.merge(rat, on="player_id", how="inner").merge(box, on="player_id", how="left").merge(ab, on="player_id", how="left")
    d["def_good"] = -d["def"]
    d = d.sort_values("net", ascending=False).reset_index(drop=True)
    d["rank"] = np.arange(1, len(d) + 1)
    now = pd.Timestamp.now(tz="UTC").isoformat()

    def num(v, nd=2):
        return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), nd)

    rows = []
    for r in d.itertuples():
        rows.append(
            {
                "season": SEASON, "kind": "current", "player_id": int(r.player_id), "name": r.roster_name, "team_id": int(r.team_id), "team": r.team,
                "net": num(r.net), "updated_at": now,
                "stats": {
                    "rank": int(r.rank), "net": num(r.net), "off": num(r.off), "def": num(r.def_good), "poss": num(r.poss, 0),
                    "pos": r.pos, "age": num(r.age, 0), "height": num(r.height, 0), "exp": num(r.exp, 0), "injury": r.injury,
                    "gp": num(r.gp, 0), "mpg": num(r.mpg, 1), "pts36": num(r.pts36, 1), "reb36": num(r.reb36, 1), "ast36": num(r.ast36, 1), "stl36": num(r.stl36, 1),
                    "blk36": num(r.blk36, 1), "tpm36": num(r.tpm36, 1), "tov36": num(r.tov36, 1), "ts": num(r.ts, 3), "tp_pct": num(r.tp_pct, 3), "usage": num(r.usage, 1),
                    "abs_margin": num(r.abs_margin), "abs_total": num(r.abs_total), "abs_pace": num(r.abs_pace), "abs_games": num(r.abs_games, 0),
                    "prior_off": num(r.prior_off), "prior_def": num(-r.prior_def), "through": f"{last}-{str(last + 1)[2:]}",
                },
            }
        )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    rows = build_rows()
    print(f"{len(rows)} rostered players with ratings")
    for r in rows[:12]:
        s = r["stats"]
        print(f"  {s['rank']:>3} {r['name']:<24} {r['team']:<24} net {s['net']:+5.1f} (off {s['off']:+.1f}, def {s['def']:+.1f})  {s['mpg']} mpg  out: {s['abs_margin']} margin / {s['abs_total']} total  inj {s['injury']}")
    if a.dry_run:
        (DATA_DIR / "last_publish_players.json").write_text(json.dumps(rows, default=str))
        print("dry run - nothing written")
        return
    publish(rows)


def publish(rows: list[dict]) -> None:
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    for i in range(0, len(rows), 300):
        client.table("nba_player_ratings").upsert(rows[i : i + 300], on_conflict="season,kind,player_id").execute()
    keep = {r["player_id"] for r in rows}
    old = client.table("nba_player_ratings").select("player_id").eq("season", SEASON).eq("kind", "current").limit(2000).execute().data or []
    stale = [o["player_id"] for o in old if o["player_id"] not in keep]
    for i in range(0, len(stale), 100):
        client.table("nba_player_ratings").delete().eq("season", SEASON).eq("kind", "current").in_("player_id", stale[i : i + 100]).execute()
    print(f"published {len(rows)} players, removed {len(stale)} stale rows")


if __name__ == "__main__":
    main()
