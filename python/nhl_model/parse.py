"""
Turns raw NHL play-by-play (cached by ingest.py) into flat tables:

  games.csv.gz      one row per game - final/regulation score, how it ended
                    (REG/OT/SO), the starting goalies, seconds spent in each
                    strength state
  shots.csv.gz      every shot attempt (goal, shot on goal, missed, blocked)
                    with geometry, shot type, strength state and the
                    immediately-preceding-event context xg.py needs
  penalties.csv.gz  every penalty

Conventions worth knowing before trusting any number downstream:

  * NHL coordinates are absolute rink positions (x in [-100, 100], the nets
    at x = +/-89), NOT flipped to the shooter's perspective - `homeTeamDefendingSide`
    on each event says which end the home team defends, which fixes each
    team's attacking net (a team shoots at the end its OPPONENT defends).
  * `situationCode` is 4 digits: [away goalie in net][away skaters][home
    skaters][home goalie in net], e.g. 1551 = 5v5 with both goalies, 1451 =
    away 4 skaters v home 5, 0651 = away goalie pulled for a 6th skater.
  * A blocked-shot event's `eventOwnerTeamId` is the BLOCKING team, so the
    shooter's team is the other one. Blocked attempts are kept (Corsi) but
    get no xG (their coordinates are where it was blocked).
  * Shootout (period 5 in the regular season) is excluded from shots/intervals
    - shootout attempts aren't comparable to live play. The shootout only
    matters via who won (games.csv.gz).
  * `final_*` scores are the OFFICIAL ones, which credit the shootout winner
    with one extra goal (a 3-3 game decided in a shootout is 4-3) - the same
    score US books settle full-game totals on. `reg_*` are goals through
    regulation only, `ot_goal` flags a decisive overtime goal.

Usage:
    python -m nhl_model.parse
"""
from __future__ import annotations

import math
from collections import defaultdict

import pandas as pd

from .ingest import DATA_DIR, RAW_PBP, SCHEDULE_CSV, read_gz

GAMES_OUT = DATA_DIR / "games.csv.gz"
SHOTS_OUT = DATA_DIR / "shots.csv.gz"
PENS_OUT = DATA_DIR / "penalties.csv.gz"

NET_X = 89.0
SHOT_EVENTS = {"shot-on-goal", "missed-shot", "blocked-shot", "goal"}


def _secs(mmss: str) -> int:
    m, s = mmss.split(":")
    return int(m) * 60 + int(s)


def _zone_rel(zone: str | None, same_team: bool) -> str | None:
    """Zone of an event from the SHOOTER's point of view (the API gives it
    from the event owner's)."""
    if zone is None or zone == "N" or same_team:
        return zone
    return {"O": "D", "D": "O"}.get(zone, zone)


def _state(sit: str) -> tuple[int, int, int, int]:
    return int(sit[0]), int(sit[1]), int(sit[2]), int(sit[3])  # a_goalie, a_skaters, h_skaters, h_goalie


def _interval_key(sit: str) -> str:
    a_g, a_s, h_s, h_g = _state(sit)
    if h_g == 0:
        return "en_home"  # home goalie pulled
    if a_g == 0:
        return "en_away"
    if a_s == h_s:
        return {5: "ev55", 4: "ev44", 3: "ev33"}.get(a_s, "ev_other")
    return "home_pp" if h_s > a_s else "away_pp"


def _attack_signs(plays: list[dict]) -> dict[tuple[int, int], int]:
    """(period, team) -> +1 / -1 for which end (sign of x) that team is
    attacking, inferred by majority vote from where its offensive-zone ('O')
    and defensive-zone ('D') events happen. Needed because older seasons'
    play-by-play has no `homeTeamDefendingSide`. Blocked shots are skipped
    (their owner is the blocking team and their zone/location semantics
    differ), as is anything near center ice."""
    votes: dict[tuple[int, int], list[int]] = defaultdict(lambda: [0, 0])  # [attacking +x, attacking -x]
    for p in plays:
        d = p.get("details") or {}
        owner, x, z = d.get("eventOwnerTeamId"), d.get("xCoord"), d.get("zoneCode")
        if owner is None or x is None or abs(x) < 25 or p["typeDescKey"] == "blocked-shot":
            continue
        key = (p["periodDescriptor"]["number"], owner)
        if z == "O":
            votes[key][0 if x > 0 else 1] += 1
        elif z == "D":
            votes[key][1 if x > 0 else 0] += 1
    return {k: (1 if r > l else -1) for k, (r, l) in votes.items() if r != l}


def parse_game(pb: dict) -> tuple[dict, list[dict], list[dict]]:
    gid = pb["id"]
    home_id, away_id = pb["homeTeam"]["id"], pb["awayTeam"]["id"]
    plays = sorted(pb.get("plays", []), key=lambda p: p["sortOrder"])

    shots: list[dict] = []
    pens: list[dict] = []
    seconds: dict[str, float] = defaultdict(float)
    reg_goals = {home_id: 0, away_id: 0}
    ot_goal_team = None
    goalie_of: dict[int, int] = {}  # team id -> first goalie seen in net for that team
    goalies_seen: dict[int, set] = {home_id: set(), away_id: set()}

    # Sorted by game clock (log order as a tie-break), NOT raw sortOrder: some
    # older games log events out of time order (a 19:59 shot after the 20:00
    # period-end), which would make consecutive-event time differences
    # double-count and push "seconds in a strength state" past the length of
    # the game.
    live = sorted(
        (p for p in plays if p["periodDescriptor"]["periodType"] != "SO"),
        key=lambda p: (p["periodDescriptor"]["number"], _secs(p["timeInPeriod"]), p["sortOrder"]),
    )
    signs = _attack_signs(live)
    for i, p in enumerate(live):
        typ = p["typeDescKey"]
        period = p["periodDescriptor"]["number"]
        ptype = p["periodDescriptor"]["periodType"]
        t = (period - 1) * 1200 + _secs(p["timeInPeriod"])
        d = p.get("details") or {}
        sit = p.get("situationCode")

        # time in strength state: this event's state holds until the next event
        if sit and i + 1 < len(live) and live[i + 1]["periodDescriptor"]["number"] == period:
            dt_s = _secs(live[i + 1]["timeInPeriod"]) - _secs(p["timeInPeriod"])
            if dt_s > 0:
                seconds[("ot_" if ptype == "OT" else "") + _interval_key(sit)] += dt_s

        if typ == "penalty":
            pens.append(
                {
                    "game_id": gid, "period": period, "t": t, "team_id": d.get("eventOwnerTeamId"),
                    "minutes": d.get("duration"), "type_code": d.get("typeCode"), "desc": d.get("descKey"),
                    "committed_by": d.get("committedByPlayerId"), "drawn_by": d.get("drawnByPlayerId"),
                }
            )

        if typ not in SHOT_EVENTS:
            continue

        owner = d.get("eventOwnerTeamId")
        shooter_team = (away_id if owner == home_id else home_id) if typ == "blocked-shot" else owner
        shooter_home = shooter_team == home_id
        goalie_id = d.get("goalieInNetId")
        if typ != "blocked-shot" and goalie_id is not None:
            def_team = away_id if shooter_home else home_id
            goalie_of.setdefault(def_team, goalie_id)
            goalies_seen[def_team].add(goalie_id)

        if typ == "goal":
            if period <= 3:
                reg_goals[shooter_team] += 1
            elif ptype == "OT":
                ot_goal_team = shooter_team

        x, y = d.get("xCoord"), d.get("yCoord")
        side = p.get("homeTeamDefendingSide")
        net_x = None
        if side in ("left", "right"):
            net_x = NET_X if (shooter_home == (side == "left")) else -NET_X
        else:
            s = signs.get((period, shooter_team))
            if s is None:
                o = signs.get((period, away_id if shooter_home else home_id))
                s = -o if o is not None else None
            if s is not None:
                net_x = NET_X * s
        dist = angle = None
        if x is not None and y is not None and net_x is not None:
            dist = math.hypot(x - net_x, y)
            angle = math.degrees(math.atan2(abs(y), abs(net_x - x))) if abs(net_x - x) > 1e-9 else 90.0

        if sit:
            a_g, a_s, h_s, h_g = _state(sit)
            sk_for, sk_against = (h_s, a_s) if shooter_home else (a_s, h_s)
            opp_goalie_in = a_g if shooter_home else h_g
        else:
            sk_for = sk_against = opp_goalie_in = None

        # context from the immediately preceding event (same period)
        prev = live[i - 1] if i > 0 and live[i - 1]["periodDescriptor"]["number"] == period else None
        prev_type = prev_dt = prev_zone = prev_dist = None
        prev_same = None
        if prev is not None:
            pd_ = prev.get("details") or {}
            prev_type = prev["typeDescKey"]
            prev_dt = t - ((period - 1) * 1200 + _secs(prev["timeInPeriod"]))
            prev_owner = pd_.get("eventOwnerTeamId")
            prev_same = prev_owner == shooter_team
            prev_zone = _zone_rel(pd_.get("zoneCode"), prev_same)
            if None not in (pd_.get("xCoord"), pd_.get("yCoord"), x, y):
                prev_dist = math.hypot(x - pd_["xCoord"], y - pd_["yCoord"])

        shots.append(
            {
                "game_id": gid, "period": period, "t": t, "event": typ,
                "shooter_team_id": shooter_team, "shooter_home": shooter_home,
                "shooter_id": d.get("shootingPlayerId") or d.get("scoringPlayerId"), "goalie_id": goalie_id,
                "x": x, "y": y, "dist": dist, "angle": angle, "shot_type": d.get("shotType"),
                "sk_for": sk_for, "sk_against": sk_against, "opp_goalie_in": opp_goalie_in,
                "prev_type": prev_type, "prev_dt": prev_dt, "prev_zone": prev_zone, "prev_same": prev_same, "prev_dist": prev_dist,
                "is_goal": 1 if typ == "goal" else 0,
            }
        )

    final_home, final_away = pb["homeTeam"].get("score"), pb["awayTeam"].get("score")
    last_period = (pb.get("gameOutcome") or {}).get("lastPeriodType")
    game = {
        "game_id": gid, "season": pb.get("season"), "start_utc": pb.get("startTimeUTC"),
        "home_team_id": home_id, "away_team_id": away_id,
        "home_abbrev": pb["homeTeam"].get("abbrev"), "away_abbrev": pb["awayTeam"].get("abbrev"),
        "final_home": final_home, "final_away": final_away, "last_period": last_period,
        "reg_home": reg_goals[home_id], "reg_away": reg_goals[away_id],
        "ot_goal": 1 if ot_goal_team else 0,
        "home_goalie": goalie_of.get(home_id), "away_goalie": goalie_of.get(away_id),
        "home_goalies_used": len(goalies_seen[home_id]), "away_goalies_used": len(goalies_seen[away_id]),
        **{f"sec_{k}": v for k, v in seconds.items()},
    }
    # Regulation clock actually covered by events - well under 3600 means the
    # feed dropped stretches of the game (seen in a few older games), so its
    # strength-state seconds undercount and shouldn't be trusted per-minute.
    game["tracked_reg_seconds"] = sum(v for k, v in seconds.items() if not k.startswith("ot_"))
    return game, shots, pens


def run() -> None:
    sched = pd.read_csv(SCHEDULE_CSV)
    done = set(sched.loc[sched["game_state"].isin(["FINAL", "OFF"]), "game_id"])
    games, shots, pens = [], [], []
    bad = 0
    files = sorted(RAW_PBP.glob("*/*.json.gz"))
    for n, path in enumerate(files, 1):
        if int(path.name.split(".")[0]) not in done:
            continue
        try:
            g, s, p = parse_game(read_gz(path))
        except Exception as e:  # one malformed game shouldn't sink the run
            bad += 1
            print(f"skip {path.name}: {str(e)[:100]}")
            continue
        games.append(g)
        shots.extend(s)
        pens.extend(p)
        if n % 2000 == 0:
            print(f"  parsed {n}/{len(files)}")
    pd.DataFrame(games).to_csv(GAMES_OUT, index=False)
    pd.DataFrame(shots).to_csv(SHOTS_OUT, index=False)
    pd.DataFrame(pens).to_csv(PENS_OUT, index=False)
    print(f"{len(games)} games, {len(shots)} shot attempts, {len(pens)} penalties ({bad} skipped) -> {DATA_DIR}")


if __name__ == "__main__":
    run()
