"""
Lineup adjustment: who is actually available tonight vs the lineup the team's rating was built on.

The simulator's team rates come from team results, faded over time. They know nothing about a trade, a signing or an
injury until enough games have been played. Skater ratings (player_ratings.py) are attached to the PLAYER, so they travel.
This module turns that into a small, capped nudge to each team's even-strength expected-goal rates:

  baseline lineup   the skaters who actually dressed in the team's last year of games, faded with the same half-life as
                    the team rating itself - i.e. the lineup that rating "contains"
  expected lineup   the team's CURRENT roster (NHL roster feed - includes off-season moves immediately) minus ESPN's
                    injured players (Out / IR / suspended = out, day-to-day = half), top 12 forwards + 6 defensemen
  value of a lineup sum over skaters of (his offence or defence rating, xG per 60) x (his usual 5v5 minutes) / 60,
                    which is the xG per game a lineup is worth against an average one

  adjustment = SLOPE x (expected - baseline), separately for offence and defence, capped at +-CAP xG per game.

SLOPE: lineup_test.py fitted 0.67 (a lineup's summed rating predicted its realised 5v5 xG differential with that slope),
on lineups that actually dressed. The roster feed gives the EXPECTED lineup (it can't see scratches), so production uses
0.5. The adjustment is part of the model's single set of numbers - there is no second model.
"""
from __future__ import annotations

import re
import unicodedata

import numpy as np
import pandas as pd
import requests

from .ingest import DATA_DIR, HEADERS, NHL_WEB
from .player_ratings import RATINGS_JSON, STINTS_OUT
from .team_stats import TEAM_NAMES

SLOPE = 0.5  # backtested slope was 0.67 on lineups that actually dressed; production uses EXPECTED lineups, so a haircut
CAP = 0.20  # xG per game, per team and per direction - a single missing star is ~0.1, so this only binds in extreme cases
FORWARDS, DEFENSE = 12, 6
BASELINE_DAYS = 365
HALF_LIFE_DAYS = 120.0  # matches SimConfig.half_life_days
ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries"
OUT_STATUSES = {"out", "injured reserve", "suspension"}


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def fetch_rosters(abbrevs: list[str]) -> dict[str, list[dict]]:
    """team abbreviation -> [{id, name, pos}] from the NHL's current-roster feed (goalies excluded)."""
    out: dict[str, list[dict]] = {}
    for ab in abbrevs:
        try:
            r = requests.get(f"{NHL_WEB}/roster/{ab}/current", headers=HEADERS, timeout=30)
            if r.status_code != 200:
                continue
            d = r.json()
        except Exception:  # noqa: BLE001
            continue
        out[ab] = [
            {"id": int(p["id"]), "name": f"{p['firstName']['default']} {p['lastName']['default']}", "pos": "D" if group == "defensemen" else "F"}
            for group in ("forwards", "defensemen")
            for p in d.get(group, [])
        ]
    return out


def fetch_injuries() -> dict[str, dict[str, float]]:
    """normalised ESPN team name -> {normalised player name: share unavailable (1 = out, 0.5 = day-to-day)}."""
    try:
        data = requests.get(ESPN_INJURIES, headers=HEADERS, timeout=30).json()
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, dict[str, float]] = {}
    for t in data.get("injuries", []):
        m: dict[str, float] = {}
        for i in t.get("injuries", []):
            status = (i.get("status") or "").lower()
            nm = (i.get("athlete") or {}).get("displayName")
            if not nm:
                continue
            if status in OUT_STATUSES:
                m[_norm(nm)] = 1.0
            elif "day" in status:
                m[_norm(nm)] = 0.5
        out[_norm(t.get("displayName", ""))] = m
    return out


class LineupAdjuster:
    def __init__(self, now: pd.Timestamp):
        self.ok = False
        if not RATINGS_JSON.exists() or not STINTS_OUT.exists():
            return
        r = pd.read_json(RATINGS_JSON)
        self.rating = {int(p): (float(o), float(d), float(t)) for p, o, d, t in zip(r["player_id"], r["off"], r["def"], r["toi_pg"])}
        self.names = {int(p): n for p, n in zip(r["player_id"], r["name"])}

        # the lineups that fed each team's rating: dressed skaters per team-game, with a recency weight
        games = pd.read_csv(DATA_DIR / "games.csv.gz", usecols=["game_id", "start_utc", "home_team_id", "away_team_id", "home_abbrev", "away_abbrev"])
        games["t"] = pd.to_datetime(games["start_utc"], utc=True)
        games = games[(games["t"] <= now) & (games["t"] >= now - pd.Timedelta(days=BASELINE_DAYS))].set_index("game_id")
        st = pd.read_csv(STINTS_OUT, usecols=["game_id"] + [f"h{i}" for i in range(5)] + [f"a{i}" for i in range(5)])
        st = st[st["game_id"].isin(games.index)]
        long_h = st.melt(id_vars="game_id", value_vars=[f"h{i}" for i in range(5)], value_name="pid")[["game_id", "pid"]].drop_duplicates()
        long_a = st.melt(id_vars="game_id", value_vars=[f"a{i}" for i in range(5)], value_name="pid")[["game_id", "pid"]].drop_duplicates()
        long_h["team"] = long_h["game_id"].map(games["home_abbrev"])
        long_a["team"] = long_a["game_id"].map(games["away_abbrev"])
        dressed = pd.concat([long_h, long_a])
        dressed["off"] = dressed["pid"].map(lambda p: self.rating.get(int(p), (0.0, 0.0, 0.0))[0] * self.rating.get(int(p), (0.0, 0.0, 0.0))[2] / 60.0)
        dressed["def"] = dressed["pid"].map(lambda p: self.rating.get(int(p), (0.0, 0.0, 0.0))[1] * self.rating.get(int(p), (0.0, 0.0, 0.0))[2] / 60.0)
        per_game = dressed.groupby(["team", "game_id"])[["off", "def"]].sum().reset_index()
        per_game["age"] = (now - per_game["game_id"].map(games["t"])).dt.total_seconds() / 86400.0
        per_game["w"] = 0.5 ** (per_game["age"] / HALF_LIFE_DAYS)
        self.baseline: dict[str, tuple[float, float]] = {}
        for team, g in per_game.groupby("team"):
            w = g["w"].to_numpy()
            self.baseline[team] = (float((g["off"] * w).sum() / w.sum()), float((g["def"] * w).sum() / w.sum()))
        # how often each player dressed for the team in that window, to tell "regular" from "arrival" in the notes
        n_games = per_game.groupby("team")["game_id"].nunique()
        self.share = {
            (team, int(pid)): c / n_games[team]
            for (team, pid), c in dressed.groupby(["team", "pid"]).size().items()
        }
        self.rosters = fetch_rosters(sorted(set(games["home_abbrev"]) | set(games["away_abbrev"])))
        self.injuries = fetch_injuries()
        self.ok = bool(self.baseline) and bool(self.rosters)

    def team(self, abbrev: str) -> dict | None:
        """The adjustment for one team: xG per game for its own offence and for what it allows, plus a short explanation."""
        if not self.ok or abbrev not in self.rosters or abbrev not in self.baseline:
            return None
        inj = self.injuries.get(_norm(TEAM_NAMES.get(abbrev, "")), {})
        avail = []
        for p in self.rosters[abbrev]:
            gone = inj.get(_norm(p["name"]), 0.0)
            if gone >= 1.0:
                continue
            o, d, toi = self.rating.get(p["id"], (0.0, 0.0, 0.0))
            avail.append({"id": p["id"], "name": p["name"], "pos": p["pos"], "off": o, "def": d, "toi": toi, "gone": gone})
        f = sorted((a for a in avail if a["pos"] == "F"), key=lambda a: -a["toi"])[:FORWARDS]
        dm = sorted((a for a in avail if a["pos"] == "D"), key=lambda a: -a["toi"])[:DEFENSE]
        lineup = f + dm
        # day-to-day players count at half
        exp_off = sum(a["off"] * a["toi"] / 60.0 * (1.0 - a["gone"]) for a in lineup)
        exp_def = sum(a["def"] * a["toi"] / 60.0 * (1.0 - a["gone"]) for a in lineup)
        b_off, b_def = self.baseline[abbrev]
        d_off = float(np.clip(SLOPE * (exp_off - b_off), -CAP, CAP))
        d_def = float(np.clip(SLOPE * (exp_def - b_def), -CAP, CAP))  # + = allows MORE xG

        value = lambda a: (a["off"] - a["def"]) * a["toi"] / 60.0  # noqa: E731
        arrivals = sorted((a for a in lineup if self.share.get((abbrev, a["id"]), 0.0) < 0.35 and a["toi"] > 0), key=lambda a: -abs(value(a)))[:3]
        in_lineup = {a["id"] for a in lineup}
        missing = []
        for (team, pid), sh in self.share.items():
            if team != abbrev or sh < 0.5 or pid in in_lineup:
                continue
            o, d, toi = self.rating.get(pid, (0.0, 0.0, 0.0))
            if toi <= 0:
                continue
            missing.append({"name": self.names.get(pid, str(pid)), "value": (o - d) * toi / 60.0})
        missing.sort(key=lambda m: -abs(m["value"]))
        return {
            "d_off": round(d_off, 3), "d_def": round(d_def, 3),
            "net_xg": round(d_off - d_def, 3),
            "arrivals": [{"name": a["name"], "value": round(value(a), 3)} for a in arrivals],
            "missing": [{"name": m["name"], "value": round(m["value"], 3)} for m in missing[:3]],
        }
