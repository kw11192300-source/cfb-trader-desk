"""
Live board refresh: Supabase in (games, snapshots, ESPN opens/closes, published ratings), cbb_game_board out.

Everything is read from Supabase so this runs anywhere (the GitHub Actions job has no raw ESPN history). Ratings come from the
published cbb_team_ratings rows (kind 'current' if present, else the roster-based 'preseason' projection).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .board import load_model, row_payload, score
from .ratings import Ratings, project


def _all(q, page: int = 1000) -> list[dict]:
    out, start = [], 0
    while True:
        rows = q.range(start, start + page - 1).execute().data or []
        out += rows
        if len(rows) < page:
            return out
        start += page


def _season_of(ts: pd.Timestamp) -> int:
    t = ts - pd.Timedelta(hours=8)
    return t.year if t.month >= 8 else t.year - 1


def load_ratings(client, season: int) -> tuple[Ratings, dict, dict, dict]:
    """(Ratings, team name -> id, id -> conference, id -> name) from the published rows."""
    for kind in ("current", "preseason"):
        rows = _all(client.table("cbb_team_ratings").select("team_id,team,conference,stats").eq("season", season).eq("kind", kind))
        if rows:
            break
    if not rows:
        raise SystemExit(f"no published team ratings for season {season}")
    s0 = rows[0]["stats"]
    mu, hca, mu_t = float(s0["mu"]), float(s0["hca"]), float(s0["mu_t"])
    off = {int(r["team_id"]): float(r["stats"]["off"]) - mu for r in rows}
    de = {int(r["team_id"]): float(r["stats"]["def"]) - mu for r in rows}
    tempo = {int(r["team_id"]): float(r["stats"]["tempo"]) for r in rows}
    ratings = Ratings(off=off, de=de, tempo=tempo, mu=mu, hca=hca, mu_t=mu_t, n_games={t: 0 for t in off})
    name_to_id = {r["team"]: int(r["team_id"]) for r in rows}
    conf = {int(r["team_id"]): r.get("conference") for r in rows}
    id_to_name = {int(r["team_id"]): r["team"] for r in rows}
    return ratings, name_to_id, conf, id_to_name


def team_games_frame(finals: pd.DataFrame) -> pd.DataFrame:
    """Two rows per finished game with each team's result against the market and rest, in time order."""
    f = finals.dropna(subset=["home_points", "away_points"]).copy()
    mk_home = -f["spread_home_close"]  # market home margin
    rows = []
    for side in ("home", "away"):
        sgn = 1.0 if side == "home" else -1.0
        d = pd.DataFrame(
            {
                "game_id": f["id"], "team_id": f[f"{side}_id"], "start": f["start"], "is_home": 1 if side == "home" else 0,
                "res_m": (f["home_points"] - f["away_points"]) * sgn - mk_home * sgn,
                "res_t": (f["home_points"] + f["away_points"]) - f["total_close"],
            }
        )
        rows.append(d)
    t = pd.concat(rows).sort_values(["team_id", "start"]).reset_index(drop=True)
    return t


def form_for(t: pd.DataFrame, team_id: int, before: pd.Timestamp) -> dict:
    h = t[(t["team_id"] == team_id) & (t["start"] < before)]
    last = h.tail(10)
    m5, m10 = h["res_m"].tail(5), h["res_m"].tail(10)
    t5, t10 = h["res_t"].tail(5), h["res_t"].tail(10)
    mean = lambda s: float(s.mean()) if s.notna().sum() >= 3 else np.nan  # noqa: E731
    rest = 14.0 if h.empty else float(min((before - h["start"].iloc[-1]).total_seconds() / 86400.0, 14.0))
    return {"f5_m": mean(m5), "f10_m": mean(m10), "f5_t": mean(t5), "f10_t": mean(t10), "rest": rest, "n": int(len(h)), "last": last}


def refresh(days: int = 3, dry_run: bool = False) -> None:
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    now = pd.Timestamp.now(tz="UTC")
    up = _all(
        client.table("games").select("id,start_date,season,home_team,away_team,neutral_site,completed")
        .eq("sport", "cbb").eq("completed", False)
        .gte("start_date", (now - pd.Timedelta(hours=6)).isoformat()).lte("start_date", (now + pd.Timedelta(days=days)).isoformat())
    )
    if not up:
        print("no upcoming CBB games on the board yet")
        return
    up = pd.DataFrame(up)
    up["start"] = pd.to_datetime(up["start_date"], utc=True)
    season = _season_of(up["start"].min())
    ratings, name_to_id, conf, id_to_name = load_ratings(client, season)
    up["home_id"] = up["home_team"].map(name_to_id)
    up["away_id"] = up["away_team"].map(name_to_id)
    miss = up[up["home_id"].isna() | up["away_id"].isna()]
    if len(miss):
        print(f"  {len(miss)} games skipped: team not in the published ratings ({sorted(set(miss['home_team']) | set(miss['away_team']))[:6]}...)")
    up = up.dropna(subset=["home_id", "away_id"]).copy()
    up["home_id"], up["away_id"] = up["home_id"].astype(int), up["away_id"].astype(int)

    # finished games this season with ESPN's closing numbers -> each team's results against the market
    fin = _all(client.table("games").select("id,start_date,home_team,away_team,home_points,away_points").eq("sport", "cbb").eq("completed", True).eq("season", season))
    fin = pd.DataFrame(fin)
    form_frame = pd.DataFrame()
    if len(fin):
        fin["start"] = pd.to_datetime(fin["start_date"], utc=True)
        fin["home_id"], fin["away_id"] = fin["home_team"].map(name_to_id), fin["away_team"].map(name_to_id)
        ids = fin["id"].tolist()
        closes = []
        for i in range(0, len(ids), 300):
            closes += client.table("cbb_game_opens").select("game_id,spread_home_close,total_close").in_("game_id", ids[i : i + 300]).execute().data or []
        c = pd.DataFrame(closes)
        if len(c):
            fin = fin.merge(c.rename(columns={"game_id": "id"}), on="id", how="inner").dropna(subset=["home_id", "away_id", "spread_home_close", "total_close"])
            fin["home_id"], fin["away_id"] = fin["home_id"].astype(int), fin["away_id"].astype(int)
            form_frame = team_games_frame(fin)
    # every finished game (not only lined ones) counts for games played and rest
    played = pd.DataFrame()
    if len(fin) or True:
        allfin = pd.DataFrame(_all(client.table("games").select("id,start_date,home_team,away_team").eq("sport", "cbb").eq("completed", True).eq("season", season)))
        if len(allfin):
            allfin["start"] = pd.to_datetime(allfin["start_date"], utc=True)
            rows = []
            for side in ("home_team", "away_team"):
                d = allfin[["start"]].copy()
                d["team_id"] = allfin[side].map(name_to_id)
                rows.append(d)
            played = pd.concat(rows).dropna(subset=["team_id"]).astype({"team_id": int}).sort_values(["team_id", "start"])

    gids = up["id"].tolist()
    opens, snaps = [], []
    for i in range(0, len(gids), 200):
        part = gids[i : i + 200]
        opens += client.table("cbb_game_opens").select("game_id,spread_home_open,total_open,ml_home_open,ml_away_open").in_("game_id", part).execute().data or []
        snaps += (
            client.table("cbb_odds_snapshots").select("game_id,captured_at,ml_home,ml_away,spread_home_line,spread_home_odds,total_line,over_odds,under_odds")
            .in_("game_id", part).order("captured_at", desc=False).limit(20000).execute().data or []
        )
    op = pd.DataFrame(opens).drop_duplicates("game_id").set_index("game_id") if opens else pd.DataFrame()
    sn = pd.DataFrame(snaps)
    first = sn.drop_duplicates("game_id", keep="first").set_index("game_id") if len(sn) else pd.DataFrame()
    cur = sn.drop_duplicates("game_id", keep="last").set_index("game_id") if len(sn) else pd.DataFrame()

    rows = []
    for g in up.itertuples():
        p = project(ratings, int(g.home_id), int(g.away_id), neutral=bool(g.neutral_site))
        if not p:
            continue
        gid = int(g.id)
        c = cur.loc[gid] if gid in cur.index else None
        o = op.loc[gid] if gid in op.index else None
        f0 = first.loc[gid] if gid in first.index else None
        open_spread = None
        if o is not None and pd.notna(o.get("spread_home_open")):
            open_spread = float(o["spread_home_open"])
        elif f0 is not None and pd.notna(f0.get("spread_home_line")):
            open_spread = float(f0["spread_home_line"])  # first number we saw
        open_total = None
        if o is not None and pd.notna(o.get("total_open")):
            open_total = float(o["total_open"])
        elif f0 is not None and pd.notna(f0.get("total_line")):
            open_total = float(f0["total_line"])
        cur_spread = float(c["spread_home_line"]) if c is not None and pd.notna(c.get("spread_home_line")) else open_spread
        cur_total = float(c["total_line"]) if c is not None and pd.notna(c.get("total_line")) else open_total
        fh = form_for(form_frame, int(g.home_id), g.start) if len(form_frame) else {"f5_m": np.nan, "f10_m": np.nan, "f5_t": np.nan, "f10_t": np.nan, "rest": 14.0}
        fa = form_for(form_frame, int(g.away_id), g.start) if len(form_frame) else {"f5_m": np.nan, "f10_m": np.nan, "f5_t": np.nan, "f10_t": np.nan, "rest": 14.0}
        ph = played[(played["team_id"] == g.home_id) & (played["start"] < g.start)] if len(played) else pd.DataFrame()
        pa = played[(played["team_id"] == g.away_id) & (played["start"] < g.start)] if len(played) else pd.DataFrame()
        rest_h = 14.0 if ph.empty else float(min((g.start - ph["start"].iloc[-1]).total_seconds() / 86400.0, 14.0))
        rest_a = 14.0 if pa.empty else float(min((g.start - pa["start"].iloc[-1]).total_seconds() / 86400.0, 14.0))
        same_conf = bool(conf.get(int(g.home_id)) and conf.get(int(g.home_id)) == conf.get(int(g.away_id)))
        rows.append(
            {
                "game_id": gid, "start_utc": g.start, "season": int(g.season), "home_id": int(g.home_id), "away_id": int(g.away_id),
                "home_team": g.home_team, "away_team": g.away_team,
                "spread": p["spread"], "total": p["total"], "poss": p["poss"], "neutral": float(bool(g.neutral_site)), "conf_game": float(same_conf),
                "n_h": float(len(ph)), "n_a": float(len(pa)),
                "mo": -open_spread if open_spread is not None else np.nan, "total_open": open_total if open_total is not None else np.nan,
                "cur_margin": -cur_spread if cur_spread is not None else np.nan, "cur_total": cur_total if cur_total is not None else np.nan,
                "cur_ml_home": float(c["ml_home"]) if c is not None and pd.notna(c.get("ml_home")) else np.nan,
                "cur_ml_away": float(c["ml_away"]) if c is not None and pd.notna(c.get("ml_away")) else np.nan,
                "cur_spread_odds": float(c["spread_home_odds"]) if c is not None and pd.notna(c.get("spread_home_odds")) else np.nan,
                "over_odds": float(c["over_odds"]) if c is not None and pd.notna(c.get("over_odds")) else np.nan,
                "under_odds": float(c["under_odds"]) if c is not None and pd.notna(c.get("under_odds")) else np.nan,
                "rest_h": rest_h, "rest_a": rest_a,
                "f5_m_h": fh["f5_m"], "f10_m_h": fh["f10_m"], "f5_t_h": fh["f5_t"], "f10_t_h": fh["f10_t"],
                "f5_m_a": fa["f5_m"], "f10_m_a": fa["f10_m"], "f5_t_a": fa["f5_t"], "f10_t_a": fa["f10_t"],
            }
        )
    df = pd.DataFrame(rows)
    df["start_utc"] = pd.to_datetime(df["start_utc"], utc=True)
    df = _features(df)
    bundle = load_model()
    b = score(df, bundle)
    # no number posted yet: projection only, no move/bet fields
    nolines = b["mo"].isna() | b["total_open"].isna()
    for col in ("pred_move_s", "pred_move_t", "exp_close_margin", "exp_close_total", "rem_s", "rem_t", "p_home_cover", "p_over", "exp_close_p_home", "ml_clv_p"):
        b.loc[nolines, col] = np.nan
    for col in ("spread_side", "total_side", "ml_side"):
        b.loc[nolines, col] = None
    b["spread_clv"] = b["spread_clv"].where(~nolines)
    b["total_clv"] = b["total_clv"].where(~nolines)
    now_iso = pd.Timestamp.now(tz="UTC").isoformat()

    def num(v):
        return None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v)

    out = [
        {
            "game_id": int(r["game_id"]), "start_date": r["start_utc"].isoformat(), "season": int(r["season"]),
            "home_team_id": int(r["home_id"]), "away_team_id": int(r["away_id"]), "home_team": r["home_team"], "away_team": r["away_team"],
            "spread_clv": num(r["spread_clv"]), "total_clv": num(r["total_clv"]), "spread_move": num(r["pred_move_s"]), "total_move": num(r["pred_move_t"]),
            "payload": row_payload(r), "updated_at": now_iso,
        }
        for _, r in b.iterrows()
    ]
    print(f"{len(out)} games scored ({int((~nolines).sum())} with lines)")
    if dry_run:
        for r in out[:8]:
            print(" ", r["away_team"], "@", r["home_team"], "| spread clv", r["spread_clv"], "total clv", r["total_clv"], "| move", r["spread_move"], r["total_move"])
        return
    for i in range(0, len(out), 300):
        client.table("cbb_game_board").upsert(out[i : i + 300], on_conflict="game_id").execute()
    print(f"published {len(out)} rows to cbb_game_board")


def _features(m: pd.DataFrame) -> pd.DataFrame:
    from .movement import add_features

    m = m.copy()
    m["early"] = 0.0  # recomputed in add_features from n_h / n_a
    return add_features(m)
