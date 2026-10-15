"""
Turns the raw ESPN files (ingest.py) into the tables the model works from, under python/data/cbb/:

  team_games.csv.gz   one row per team per game: points, the box-score line, estimated possessions, tempo, home/neutral flags
  player_games.csv.gz one row per player per game: minutes and counting stats, starter flag (the input to player ratings)
  closing_odds.csv    one row per game: DraftKings-first closing and opening spread/total/moneyline from ESPN's odds history

Possessions use the standard box-score estimate  FGA - OREB + TO + 0.475*FTA  for each team; the game's possessions are the
average of the two (they differ by at most one or two possessions in reality). Overtime games are handled by scaling to a
per-40-minute tempo.

Usage:
    python -m cbb_model.parse
"""
from __future__ import annotations

import re

import pandas as pd

from .ingest import DATA_DIR, RAW_GAMES, RAW_ODDS, SCHEDULE_CSV, read_gz

TEAM_GAMES_OUT = DATA_DIR / "team_games.csv.gz"
PLAYER_GAMES_OUT = DATA_DIR / "player_games.csv.gz"
CLOSING_ODDS_OUT = DATA_DIR / "closing_odds.csv"


def _pair(s: str | None) -> tuple[float, float]:
    """'24-54' -> (24, 54)"""
    if not s or "-" not in s:
        return (float("nan"), float("nan"))
    a, b = s.split("-", 1)
    try:
        return (float(a), float(b))
    except ValueError:
        return (float("nan"), float("nan"))


def _num(s) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return float("nan")


def overtimes(detail: str | None) -> int:
    """'Final' -> 0, 'Final/OT' -> 1, 'Final/3OT' -> 3"""
    if not detail:
        return 0
    m = re.search(r"/(\d*)OT", detail)
    if not m:
        return 0
    return int(m.group(1)) if m.group(1) else 1


def build_team_and_player_games(season: int | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    sched = pd.read_csv(SCHEDULE_CSV)
    sched = sched[sched["completed"] & sched["home_score"].notna() & sched["away_score"].notna()]
    if season is not None:
        sched = sched[sched["season"] == season]
    trows, prows = [], []
    for r in sched.itertuples():
        path = RAW_GAMES / str(int(r.season)) / f"{int(r.event_id)}.json.gz"
        if not path.exists():
            continue
        g = read_gz(path)
        if g.get("missing") or not g.get("team_stats") or len(g["team_stats"]) != 2:
            continue
        ot = overtimes(getattr(r, "detail", None))
        by_team = {str(t["team_id"]): t for t in g["team_stats"]}
        ids = {"home": str(int(r.home_id)), "away": str(int(r.away_id))}
        if ids["home"] not in by_team or ids["away"] not in by_team:
            continue
        lines = {}
        for side in ("home", "away"):
            st = by_team[ids[side]]["stats"]
            fgm, fga = _pair(st.get("fieldGoalsMade-fieldGoalsAttempted"))
            tpm, tpa = _pair(st.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"))
            ftm, fta = _pair(st.get("freeThrowsMade-freeThrowsAttempted"))
            tov = _num(st.get("totalTurnovers") if st.get("totalTurnovers") not in (None, "") else st.get("turnovers"))
            lines[side] = dict(fgm=fgm, fga=fga, tpm=tpm, tpa=tpa, ftm=ftm, fta=fta, oreb=_num(st.get("offensiveRebounds")), dreb=_num(st.get("defensiveRebounds")),
                               ast=_num(st.get("assists")), stl=_num(st.get("steals")), blk=_num(st.get("blocks")), tov=tov, pf=_num(st.get("fouls")))
        def poss(x):
            return x["fga"] - x["oreb"] + x["tov"] + 0.475 * x["fta"]
        game_poss = (poss(lines["home"]) + poss(lines["away"])) / 2.0
        if not (game_poss > 30):
            continue
        minutes = 40 + 5 * ot
        for side, opp in (("home", "away"), ("away", "home")):
            trows.append(
                {
                    "event_id": int(r.event_id), "season": int(r.season), "start_utc": r.start_utc,
                    "team_id": int(ids[side]), "opp_id": int(ids[opp]), "team": getattr(r, side), "opp": getattr(r, opp),
                    "is_home": 1 if side == "home" else 0, "neutral": int(bool(r.neutral)), "conf_game": int(bool(r.conf_game)),
                    "season_type": r.season_type, "ot": ot,
                    "pts": getattr(r, f"{side}_score"), "opp_pts": getattr(r, f"{opp}_score"),
                    "poss": game_poss, "tempo": game_poss / minutes * 40.0,
                    **lines[side], **{f"opp_{k}": v for k, v in lines[opp].items()},
                }
            )
        for p in g.get("players", []):
            labels, stats = p.get("labels") or [], p.get("stats") or []
            if not stats or p.get("dnp"):
                continue
            d = dict(zip(labels, stats))
            side = "home" if str(p["team_id"]) == ids["home"] else "away" if str(p["team_id"]) == ids["away"] else None
            if side is None:
                continue
            fgm, fga = _pair(d.get("FG"))
            tpm, tpa = _pair(d.get("3PT"))
            ftm, fta = _pair(d.get("FT"))
            prows.append(
                {
                    "event_id": int(r.event_id), "season": int(r.season), "start_utc": r.start_utc, "team_id": int(p["team_id"]),
                    "opp_id": int(ids["away" if side == "home" else "home"]), "player_id": p["id"], "name": p["name"], "pos": p.get("pos"),
                    "starter": bool(p.get("starter")), "min": _num(d.get("MIN")), "pts": _num(d.get("PTS")), "fgm": fgm, "fga": fga, "tpm": tpm, "tpa": tpa,
                    "ftm": ftm, "fta": fta, "reb": _num(d.get("REB")), "ast": _num(d.get("AST")), "tov": _num(d.get("TO")), "stl": _num(d.get("STL")),
                    "blk": _num(d.get("BLK")), "oreb": _num(d.get("OREB")), "dreb": _num(d.get("DREB")), "pf": _num(d.get("PF")),
                }
            )
    return pd.DataFrame(trows), pd.DataFrame(prows)


def _book_rank(name: str) -> int:
    n = (name or "").lower().replace(" ", "")
    for i, key in enumerate(["draftkings", "espnbet", "caesars", "betmgm", "pointsbet", "unibet"]):
        if key in n:
            return i
    return 99


def build_closing_odds() -> pd.DataFrame:
    rows = []
    for season_dir in sorted(RAW_ODDS.glob("*")):
        for path in season_dir.glob("*.json.gz"):
            items = read_gz(path).get("items", [])
            best = None
            for it in items:
                name = (it.get("provider") or {}).get("name", "")
                if name.lower() in ("consensus", "teamrankings", "accuscore", "numberfire") or "live" in name.lower():
                    continue
                if it.get("spread") is None and it.get("overUnder") is None:
                    continue
                if best is None or _book_rank(name) < _book_rank((best.get("provider") or {}).get("name", "")):
                    best = it
            if best is None:
                continue
            home, away = best.get("homeTeamOdds") or {}, best.get("awayTeamOdds") or {}

            def amer(d, key):
                v = (d.get("open") or {}).get(key) if key == "moneyLine" else None
                return v

            def opened(d, k):
                o = (d.get("open") or {})
                x = o.get(k)
                if isinstance(x, dict):
                    return x.get("american")
                return x

            tot_open = None
            # total open lives under the "open" blob next to over/under, depending on era
            op = best.get("open") or {}
            if isinstance(op.get("total"), dict):
                tot_open = op["total"].get("american")
            rows.append(
                {
                    "event_id": int(path.name.split(".")[0]), "book": (best.get("provider") or {}).get("name"),
                    "spread_home_close": best.get("spread"), "total_close": best.get("overUnder"),
                    "over_close": best.get("overOdds"), "under_close": best.get("underOdds"),
                    "ml_home_close": home.get("moneyLine"), "ml_away_close": away.get("moneyLine"),
                    "total_open": tot_open,
                    "spread_home_open": opened(home, "pointSpread"),
                    "details": best.get("details"),
                }
            )
    return pd.DataFrame(rows)


def main() -> None:
    tg, pg = build_team_and_player_games()
    tg.to_csv(TEAM_GAMES_OUT, index=False)
    pg.to_csv(PLAYER_GAMES_OUT, index=False)
    print(f"team games: {len(tg):,} ({tg['event_id'].nunique():,} games) | player games: {len(pg):,}")
    print(tg.groupby("season")["event_id"].nunique().to_string())
    od = build_closing_odds()
    od.to_csv(CLOSING_ODDS_OUT, index=False)
    print(f"closing odds: {len(od):,} games | with spread {od['spread_home_close'].notna().sum():,}, total {od['total_close'].notna().sum():,}")


if __name__ == "__main__":
    main()
