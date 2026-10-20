"""
The live NBA projection job: reads the board's upcoming games, rosters, the injury report and the line history, runs live.py's scenario
projections and publishes nba_game_projections / nba_player_projections for the site.

    python -m nba_model.live_run              # project and publish
    python -m nba_model.live_run --dry-run    # write data/nba/live_preview.json only
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pickle

import numpy as np
import pandas as pd

from .ingest import DATA_DIR
from .live import MODELS, _key, build_state, news_move, news_swing, project_team


class _Unpickler(pickle.Unpickler):
    """props.py was run as a script when it saved its models, so its Dist class was pickled as __main__.Dist."""

    def find_class(self, module, name):
        if name == "Dist":
            from .props import Dist

            return Dist
        return super().find_class(module, name)


def load_models() -> tuple[dict, dict, dict, dict]:
    with open(MODELS / "nba_minutes_model.pkl", "rb") as f:
        mb = _Unpickler(f).load()
    with open(MODELS / "nba_props_models.pkl", "rb") as f:
        pb = _Unpickler(f).load()
    probs = json.loads((MODELS / "nba_injury_probs.json").read_text())
    coef = json.loads((MODELS / "nba_reprice.json").read_text())
    return mb, pb, probs, coef


def run(dry_run: bool = False, horizon_h: float = 40.0) -> None:
    from cfbd_ingest.supabase_client import get_client

    from . import inseason
    from .ingest import ingest_games, ingest_schedule, season_of
    from .players_table import current_rosters
    from .reprice import p_play as status_p

    client = get_client()
    now = dt.datetime.now(dt.timezone.utc)
    games = (
        client.table("games").select("id,start_date,home_team,away_team,season")
        .eq("sport", "nba").eq("completed", False).gt("start_date", now.isoformat()).lt("start_date", (now + dt.timedelta(hours=horizon_h)).isoformat())
        .order("start_date").execute().data or []
    )
    print(f"{len(games)} upcoming games in the next {horizon_h:.0f}h", flush=True)
    if not games:
        return
    season = season_of(dt.date.today())
    inseason.refresh_recent_cache(season)
    ingest_schedule(season, season)
    ingest_games(season, season)
    inseason.build_tables(season)
    state = build_state(emit=False)
    last_t = max((st["last_t"] for st in state["pstate"].values() if "last_t" in st), default=None)
    print(f"state built through {last_t}", flush=True)
    mb, pb, probs, coef = load_models()
    rng = np.random.default_rng(0)

    ros = current_rosters()
    team_id = {r.team: int(r.team_id) for r in ros.drop_duplicates("team").itertuples()}
    roster = {int(tid): [(int(p), n) for p, n in zip(g["player_id"], g["roster_name"])] for tid, g in ros.groupby("team_id")}
    rat = client.table("nba_player_ratings").select("player_id,net").eq("season", season).eq("kind", "current").limit(2000).execute().data or []
    net = {int(r["player_id"]): float(r["net"]) for r in rat if r["net"] is not None}

    days = sorted({pd.Timestamp(g["start_date"]).tz_convert("America/New_York").strftime("%Y-%m-%d") for g in games})
    inj = client.table("nba_injury_status").select("game_date,team,player,status,reason_cat,reason_detail,report_time").in_("game_date", days).limit(5000).execute().data or []
    snaps = client.table("nba_odds_snapshots").select("game_id,captured_at,spread_home_line,total_line").in_("game_id", [g["id"] for g in games]).order("captured_at").limit(20000).execute().data or []
    first, lastsn = {}, {}
    for sn in snaps:
        first.setdefault(sn["game_id"], sn)
        lastsn[sn["game_id"]] = sn

    from .reprice import p_play as status_p  # noqa: F811 - imported above for clarity

    game_rows, player_rows = [], []
    for g in games:
        start = pd.Timestamp(g["start_date"])
        day = start.tz_convert("America/New_York").strftime("%Y-%m-%d")
        hours = (start - pd.Timestamp(now)).total_seconds() / 3600.0
        cur, op = lastsn.get(g["id"]), first.get(g["id"])
        line_now = cur["spread_home_line"] if cur else None  # the home team's own number (negative = favoured)
        line_open = op["spread_home_line"] if op else None
        em_home = -line_now if line_now is not None else 0.0
        per_team, swings, pend = {}, {}, {}
        for side, name, opp_name in (("home", g["home_team"], g["away_team"]), ("away", g["away_team"], g["home_team"])):
            tid, oid = team_id.get(name), team_id.get(opp_name)
            if tid is None or oid is None or tid not in roster:
                print(f"  skip {name}: no roster", flush=True)
                per_team = {}
                break
            members = [p for p, _ in roster[tid]]
            keymap = {_key(n): p for p, n in roster[tid]}
            names = dict(roster[tid])
            rows = [r for r in inj if r["game_date"] == day and r["team"] == name]
            pend[side] = bool(rows) and all(r["player"] == "" for r in rows)
            pp, meta = {}, {}
            for r in rows:
                if not r["player"]:
                    continue
                pid = keymap.get(_key(r["player"]))
                if pid is None:
                    continue
                pp[pid] = status_p(r["status"], hours, probs)
                meta[pid] = (r["status"], " ".join(x for x in (r["reason_cat"], r["reason_detail"]) if x))
            ctx = {"team": tid, "opp": oid, "is_home": 1 if side == "home" else 0, "start": start, "season": season, "exp_margin": em_home if side == "home" else -em_home}
            proj = project_team(state, mb, pb, members, pp, ctx, rng)
            proj["p_play"] = [pp.get(p, 1.0) for p in members]
            proj["status"] = [meta.get(p, (None, None))[0] for p in members]
            proj["reason"] = [meta.get(p, (None, None))[1] for p in members]
            proj["name"] = [names[p] for p in members]
            proj["exp_min"] = proj["p_play"] * proj["min_mean"]
            per_team[side] = (proj, tid, names)
            swings[side] = news_swing(state, members, pp, net, coef)
        if len(per_team) < 2:
            continue
        nm = news_move(swings["home"][:2], swings["away"][:2], coef)
        moved = (line_open - line_now) if (line_open is not None and line_now is not None) else None  # + = the line has moved toward home
        gap = None if moved is None else round(nm - moved, 2)
        contrib = {side: [{**w, "name": per_team[side][2].get(w["player_id"])} for w in swings[side][2]] for side in swings}
        game_rows.append(
            {
                "game_id": g["id"], "start_date": g["start_date"], "home_team": g["home_team"], "away_team": g["away_team"], "computed_at": now.isoformat(),
                "news_move": round(nm, 2), "line_open": line_open, "line_now": line_now, "moved": None if moved is None else round(moved, 2), "gap": gap,
                "pending_home": pend.get("home", False), "pending_away": pend.get("away", False),
                "detail": {"contrib": contrib, "state_through": str(last_t), "hours_to_tip": round(hours, 1)},
            }
        )
        for side, (proj, tid, _) in per_team.items():
            for r in proj.itertuples():
                if r.base_min < 3.0 and r.exp_min < 2.0:
                    continue
                down = r.p_play <= 0.03
                player_rows.append(
                    {
                        "game_id": g["id"], "player_id": int(r.player_id), "name": r.name, "team": g["home_team"] if side == "home" else g["away_team"], "side": side,
                        "p_play": round(float(r.p_play), 3), "status": r.status, "reason": r.reason, "base_min": round(float(r.base_min), 1), "n_prior": int(r.n_prior),
                        "min_mean": None if down else round(float(r.min_mean), 1), "min_q10": None if down else round(float(r.min_q10), 1), "min_q90": None if down else round(float(r.min_q90), 1),
                        "exp_min": round(float(r.exp_min), 1), "stats": None if down else r.stats, "computed_at": now.isoformat(),
                    }
                )
        print(f"  {g['away_team']} @ {g['home_team']}: news move {nm:+.2f} (line moved {moved if moved is None else round(moved, 2)}) gap {gap}", flush=True)
    if dry_run:
        (DATA_DIR / "live_preview.json").write_text(json.dumps({"games": game_rows, "players": player_rows}, default=str))
        print(f"dry run: {len(game_rows)} games, {len(player_rows)} players -> live_preview.json")
        return
    for i in range(0, len(game_rows), 100):
        client.table("nba_game_projections").upsert(game_rows[i : i + 100], on_conflict="game_id").execute()
    for i in range(0, len(player_rows), 200):
        client.table("nba_player_projections").upsert(player_rows[i : i + 200], on_conflict="game_id,player_id").execute()
    print(f"published {len(game_rows)} games, {len(player_rows)} players")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(dry_run=a.dry_run)


if __name__ == "__main__":
    main()
