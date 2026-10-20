"""
Turns the raw ESPN files (nba_model.ingest) into flat tables:

  team_games.csv.gz     one row per team per game: points, possessions, pace, shooting lines, home/away, overtimes
  player_games.csv.gz   one row per player per game: minutes, the box-score line, starter, did-not-play and the reason
  games.csv             one row per game: season, date, teams, final score, referee crew
  odds.csv              one row per game: spread / total / moneyline OPEN and CLOSE from the best available book

    python -m nba_model.parse
"""
from __future__ import annotations

import pandas as pd

from cbb_model.ingest import read_gz
from .ingest import DATA_DIR, RAW_GAMES, RAW_ODDS, SCHEDULE_CSV

TEAM_GAMES_OUT = DATA_DIR / "team_games.csv.gz"
PLAYER_GAMES_OUT = DATA_DIR / "player_games.csv.gz"
GAMES_OUT = DATA_DIR / "games.csv"
ODDS_OUT = DATA_DIR / "odds.csv"


def _pair(s: str | None) -> tuple[float, float]:
    try:
        a, b = str(s).split("-")
        return float(a), float(b)
    except (ValueError, AttributeError):
        return 0.0, 0.0


def _num(s) -> float:
    try:
        return float(str(s).replace("+", ""))
    except (ValueError, TypeError):
        return 0.0


def poss(x: dict) -> float:
    return x["fga"] - x["oreb"] + x["tov"] + 0.44 * x["fta"]  # the NBA's usual estimate (0.44 x free-throw attempts)


def build_games() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sched = pd.read_csv(SCHEDULE_CSV)
    sched = sched[sched["completed"] & sched["home_score"].notna() & sched["away_score"].notna() & (sched["season_type"] != 1)]
    trows, prows, grows = [], [], []
    for r in sched.itertuples():
        path = RAW_GAMES / str(int(r.season)) / f"{int(r.event_id)}.json.gz"
        if not path.exists():
            continue
        g = read_gz(path)
        if g.get("missing") or not g.get("team_stats") or len(g["team_stats"]) != 2:
            continue
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
                               ast=_num(st.get("assists")), stl=_num(st.get("steals")), blk=_num(st.get("blocks")), tov=tov, pf=_num(st.get("fouls")),
                               paint=_num(st.get("pointsInPaint")), fastbreak=_num(st.get("fastBreakPoints")))
        game_poss = (poss(lines["home"]) + poss(lines["away"])) / 2.0
        if not (game_poss > 60):
            continue
        ot = max(0, int(g.get("periods") or 4) - 4)
        minutes = 48 + 5 * ot
        grows.append(
            {
                "event_id": int(r.event_id), "season": int(r.season), "start_utc": r.start_utc, "season_type": r.season_type, "home_id": int(ids["home"]), "away_id": int(ids["away"]),
                "home": r.home, "away": r.away, "home_pts": int(r.home_score), "away_pts": int(r.away_score), "ot": ot, "poss": game_poss, "pace": game_poss / minutes * 48.0,
                "officials": "|".join(g.get("officials") or []), "attendance": g.get("attendance"),
            }
        )
        for side, opp in (("home", "away"), ("away", "home")):
            trows.append(
                {
                    "event_id": int(r.event_id), "season": int(r.season), "start_utc": r.start_utc, "season_type": r.season_type,
                    "team_id": int(ids[side]), "opp_id": int(ids[opp]), "team": getattr(r, side), "opp": getattr(r, opp), "is_home": 1 if side == "home" else 0,
                    "ot": ot, "pts": getattr(r, f"{side}_score"), "opp_pts": getattr(r, f"{opp}_score"), "poss": game_poss, "pace": game_poss / minutes * 48.0,
                    **lines[side], **{f"opp_{k}": v for k, v in lines[opp].items()},
                }
            )
        for p in g.get("players", []):
            labels, stats = p.get("labels") or [], p.get("stats") or []
            side = "home" if str(p["team_id"]) == ids["home"] else "away" if str(p["team_id"]) == ids["away"] else None
            if side is None:
                continue
            base = {
                "event_id": int(r.event_id), "season": int(r.season), "start_utc": r.start_utc, "team_id": int(p["team_id"]),
                "opp_id": int(ids["away" if side == "home" else "home"]), "is_home": 1 if side == "home" else 0,
                "player_id": p["id"], "name": p["name"], "pos": p.get("pos"), "starter": bool(p.get("starter")), "dnp": bool(p.get("dnp")), "reason": p.get("reason") if p.get("dnp") else None,
            }
            if not stats or p.get("dnp"):
                prows.append({**base, "min": 0.0})
                continue
            d = dict(zip(labels, stats))
            fgm, fga = _pair(d.get("FG"))
            tpm, tpa = _pair(d.get("3PT"))
            ftm, fta = _pair(d.get("FT"))
            prows.append(
                {
                    **base, "min": _num(d.get("MIN")), "pts": _num(d.get("PTS")), "fgm": fgm, "fga": fga, "tpm": tpm, "tpa": tpa, "ftm": ftm, "fta": fta,
                    "reb": _num(d.get("REB")), "ast": _num(d.get("AST")), "tov": _num(d.get("TO")), "stl": _num(d.get("STL")), "blk": _num(d.get("BLK")),
                    "oreb": _num(d.get("OREB")), "dreb": _num(d.get("DREB")), "pf": _num(d.get("PF")), "pm": _num(d.get("+/-")),
                }
            )
    return pd.DataFrame(trows), pd.DataFrame(prows), pd.DataFrame(grows)


def _book_rank(name: str) -> int:
    n = (name or "").lower().replace(" ", "")
    for i, key in enumerate(["draftkings", "espnbet", "caesars", "mgm", "unibet", "sugarhouse", "betfair"]):
        if key in n:
            return i
    return 99


def _amer(x) -> float | None:
    """ESPN's price/line blobs: {"american": "+9.5"} or a plain number."""
    if isinstance(x, dict):
        x = x.get("american", x.get("value"))
    try:
        return float(str(x).replace("+", ""))
    except (TypeError, ValueError):
        return None


def build_odds() -> pd.DataFrame:
    rows = []
    for season_dir in sorted(RAW_ODDS.glob("*")):
        for path in season_dir.glob("*.json.gz"):
            items = read_gz(path).get("items", [])
            best = None
            for it in items:
                name = (it.get("provider") or {}).get("name", "")
                if name.lower() in ("consensus", "teamrankings", "accuscore", "numberfire") or "live" in name.lower():
                    continue
                h = it.get("homeTeamOdds") or {}
                if not (h.get("close") or {}).get("pointSpread") and it.get("spread") is None:
                    continue
                if best is None or _book_rank(name) < _book_rank((best.get("provider") or {}).get("name", "")):
                    best = it
            if best is None:
                continue
            h, a = best.get("homeTeamOdds") or {}, best.get("awayTeamOdds") or {}
            op, cl = best.get("open") or {}, best.get("close") or {}
            rows.append(
                {
                    "event_id": int(path.name.split(".")[0]), "book": (best.get("provider") or {}).get("name"),
                    "spread_home_open": _amer((h.get("open") or {}).get("pointSpread")), "spread_home_close": _amer((h.get("close") or {}).get("pointSpread")),
                    "total_open": _amer(op.get("total")), "total_close": _amer(cl.get("total")),
                    "ml_home_open": _amer((h.get("open") or {}).get("moneyLine")), "ml_home_close": _amer((h.get("close") or {}).get("moneyLine")),
                    "ml_away_open": _amer((a.get("open") or {}).get("moneyLine")), "ml_away_close": _amer((a.get("close") or {}).get("moneyLine")),
                    "spread_odds_home_close": _amer((h.get("close") or {}).get("spread")), "spread_odds_away_close": _amer((a.get("close") or {}).get("spread")),
                    "over_close": _amer(cl.get("over")), "under_close": _amer(cl.get("under")),
                }
            )
    return pd.DataFrame(rows)


def main() -> None:
    tg, pg, gm = build_games()
    tg.to_csv(TEAM_GAMES_OUT, index=False)
    pg.to_csv(PLAYER_GAMES_OUT, index=False)
    gm.to_csv(GAMES_OUT, index=False)
    print(f"games {len(gm):,} | team games {len(tg):,} | player games {len(pg):,}")
    print(gm.groupby("season").size().to_string())
    od = build_odds()
    od.to_csv(ODDS_OUT, index=False)
    print(f"odds: {len(od):,} games | with spread open+close {int((od['spread_home_open'].notna() & od['spread_home_close'].notna()).sum()):,} | total open+close {int((od['total_open'].notna() & od['total_close'].notna()).sum()):,}")


if __name__ == "__main__":
    main()
