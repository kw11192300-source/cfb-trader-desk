"""Shared news: the same injury and availability events reach every group at the same moment, and we record how the market reacts to each.

Source: ESPN's public injury lists (NBA, NHL, NFL; college football and basketball lists are not usable). Each round the lists are fetched and compared with the last ones. A player added, a status
change (questionable to out, out to cleared) and a player removed are events. Each event is tied to the next game its team plays, and the DraftKings line and the exchange's prices on that game's
main lines are recorded at the moment the event is seen, then again about 30 minutes and about two hours later, so we can see how far and how fast each moved. The labs also receive the current
injury list and recent events for both teams of every game, which is what lets one of them build an injury lens.

Everything is kept in ex_meta key "news": {"state": current lists, "events": newest first, ...}.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import espn

ENDPOINTS = {"nba": "basketball/nba", "nhl": "hockey/nhl", "nfl": "football/nfl"}
KEEP_DAYS = 10
MAX_EVENTS = 300
LOOKAHEAD_H = 72  # an event is tied to its team's next game when that game starts within this many hours
CHECKS = (("r1", 30), ("r2", 120))  # minutes after the event at which the market is looked at again


def load(meta: dict) -> dict:
    v = meta.get("news") or {}
    return {"state": v.get("state"), "events": v.get("events", []), "dirty": False}


def dump(s: dict) -> dict:
    return {"state": s["state"], "events": s["events"][:MAX_EVENTS]}


def fetch() -> dict:
    """The current injury lists: {sport: {team id: {"name": team, "p": {player: {pos, status, detail, date, note, ret}}}}}."""
    out: dict = {}
    for sp, path in ENDPOINTS.items():
        try:
            j = espn._get(f"{espn.BASE}/{path}/injuries", {})
        except Exception:
            continue
        teams: dict = {}
        for t in j.get("injuries", []):
            d: dict = {}
            for i in t.get("injuries", []):
                a = i.get("athlete") or {}
                name = a.get("displayName")
                if not name:
                    continue
                det = i.get("details") or {}
                d[name] = {"pos": (a.get("position") or {}).get("abbreviation"), "status": i.get("status"), "detail": det.get("type"), "date": i.get("date"),
                           "note": (i.get("shortComment") or "")[:160], "ret": det.get("returnDate")}
            teams[str(t["id"])] = {"name": t.get("displayName"), "p": d}
        if teams:
            out[sp] = teams
    return out


def _main(g: dict) -> dict:
    ref = g.get("ref") or {}
    v = g.get("views") or {}
    xs = {}
    for (kind, line), x in zip(v.get("lines", []), v.get("x", []) or []):
        if kind in ("spread", "total") and x is not None:
            xs[kind] = round(x, 4)
    return {"spread": ref.get("spread"), "total": ref.get("total"), "ml": ref.get("ml_home"), "x": xs}


def _game_of(games: dict, sport: str, team: str, now: datetime):
    best = None
    for g in games.values():
        if g["sport"] != sport or g["state"] != "pre" or team not in (g["home"]["id"], g["away"]["id"]):
            continue
        st = datetime.fromisoformat(g["start_utc"].replace("Z", "+00:00"))
        h = (st - now).total_seconds() / 3600
        if 0.25 < h <= LOOKAHEAD_H and (best is None or st < best[0]):
            best = (st, g)
    return best[1] if best else None


def refresh(s: dict, cur: dict, games: dict, now: datetime) -> int:
    """Compares the fresh lists with the stored ones, opens an event for every change, and fills in the later market checks on earlier events. Returns the number of new events."""
    new = 0
    old = s["state"]
    if cur:
        if old is not None:  # the first run only sets the baseline, so the lists already there are not all treated as news
            seen = {e["id"] for e in s["events"]}
            for sp, teams in cur.items():
                for tid, t in teams.items():
                    prev = ((old.get(sp) or {}).get(tid) or {}).get("p", {})
                    for name, p in t["p"].items():
                        was = prev.get(name)
                        if was is None:
                            kind, pstat = "added", None
                        elif was.get("status") != p.get("status"):
                            kind, pstat = "changed", was.get("status")
                        else:
                            continue
                        eid = f"{sp}|{tid}|{name}|{p.get('status')}|{p.get('date')}"
                        if eid in seen:
                            continue
                        g = _game_of(games, sp, tid, now)
                        ev = {"id": eid, "ts": now.isoformat(), "sport": sp, "team": tid, "team_name": t["name"], "player": name, "pos": p.get("pos"), "status": p.get("status"), "prev": pstat,
                              "kind": kind, "detail": p.get("detail"), "note": p.get("note"), "ret": p.get("ret"), "reported": p.get("date")}
                        if g:
                            ev.update(gid=g["id"], teams=f"{g['away']['abbr']} @ {g['home']['abbr']}", start=g["start_utc"], r0=_main(g))
                        s["events"].insert(0, ev)
                        new += 1
                    for name, was in prev.items():
                        if name not in t["p"]:
                            eid = f"{sp}|{tid}|{name}|cleared|{was.get('date')}"
                            if eid in {e["id"] for e in s["events"][:100]}:
                                continue
                            g = _game_of(games, sp, tid, now)
                            ev = {"id": eid, "ts": now.isoformat(), "sport": sp, "team": tid, "team_name": t["name"], "player": name, "pos": was.get("pos"), "status": "Cleared", "prev": was.get("status"),
                                  "kind": "cleared", "detail": was.get("detail"), "note": "", "ret": None, "reported": None}
                            if g:
                                ev.update(gid=g["id"], teams=f"{g['away']['abbr']} @ {g['home']['abbr']}", start=g["start_utc"], r0=_main(g))
                            s["events"].insert(0, ev)
                            new += 1
        merged = dict(old or {})
        merged.update({sp: {tid: {"name": t["name"], "p": {n: {k: v for k, v in p.items() if k in ("pos", "status", "date", "detail")} for n, p in t["p"].items()}} for tid, t in teams.items()} for sp, teams in cur.items()})
        s["state"] = merged
        s["dirty"] = True
    # later looks at the market on events tied to a game
    for e in s["events"]:
        if not e.get("gid") or e["gid"] not in games:
            continue
        age = (now - datetime.fromisoformat(e["ts"])).total_seconds() / 60
        for key, mins in CHECKS:
            if key not in e and age >= mins and games[e["gid"]]["state"] == "pre":
                e[key] = _main(games[e["gid"]])
                s["dirty"] = True
    cut = (now - timedelta(days=KEEP_DAYS)).isoformat()
    if any(e["ts"] < cut for e in s["events"]):
        s["events"] = [e for e in s["events"] if e["ts"] >= cut]
        s["dirty"] = True
    return new


def for_game(s: dict, g: dict, hours: float = 72.0) -> dict:
    """What a model is told about a game's two teams: who is on the injury list and what has changed lately."""
    st = s.get("state") or {}
    sp = g["sport"]
    out: dict = {"home": [], "away": [], "events": []}
    for side in ("home", "away"):
        t = ((st.get(sp) or {}).get(g[side]["id"]) or {}).get("p", {})
        out[side] = [{"player": n, "pos": p.get("pos"), "status": p.get("status")} for n, p in t.items()]
    ids = {g["home"]["id"], g["away"]["id"]}
    cut = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    out["events"] = [{"ts": e["ts"], "team": e["team"], "player": e["player"], "pos": e.get("pos"), "status": e["status"], "prev": e.get("prev")} for e in s.get("events", []) if e["team"] in ids and e["sport"] == sp and e["ts"] >= cut][:20]
    return out
