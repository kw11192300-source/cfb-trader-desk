"""ESPN scoreboard -> events with the DraftKings baseline lines (open and close) for NFL, CFB, NHL, NBA and CBB."""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

BASE = "https://site.api.espn.com/apis/site/v2/sports"
SPORTS: dict[str, tuple[str, dict]] = {
    "nfl": ("football/nfl", {}),
    "cfb": ("football/college-football", {"groups": 80, "limit": 200}),
    "nhl": ("hockey/nhl", {}),
    "nba": ("basketball/nba", {}),
    "cbb": ("basketball/mens-college-basketball", {"groups": 50, "limit": 400}),
}
HEADERS = {"User-Agent": "Mozilla/5.0"}


def _get(url: str, params: dict, tries: int = 3) -> dict:
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=45)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
        time.sleep(1.5 * (i + 1))
    return {}


def _num(s) -> float | None:
    if s is None:
        return None
    m = re.search(r"[-+]?\d+(?:\.\d+)?", str(s))
    return float(m.group()) if m else None


def _pair(block: dict, side: str, which: str) -> tuple[float | None, float | None]:
    d = ((block or {}).get(side) or {}).get(which) or {}
    return _num(d.get("line")), _num(d.get("odds"))


def _odds(o: dict, which: str) -> dict | None:
    """One DraftKings snapshot ('open' or 'close') as plain numbers: home spread + both prices, total + both prices, both moneylines."""
    sh, sh_o = _pair(o.get("pointSpread"), "home", which)
    sa, sa_o = _pair(o.get("pointSpread"), "away", which)
    to, to_o = _pair(o.get("total"), "over", which)
    tu, tu_o = _pair(o.get("total"), "under", which)
    _, mh = _pair(o.get("moneyline"), "home", which)
    _, ma = _pair(o.get("moneyline"), "away", which)
    out = {"spread": sh if sh is not None else (-sa if sa is not None else None), "spread_home": sh_o, "spread_away": sa_o,
           "total": to if to is not None else tu, "over": to_o, "under": tu_o, "ml_home": mh, "ml_away": ma}
    return out if any(out[k] is not None for k in ("spread", "total", "ml_home")) else None


def parse_event(sport: str, e: dict) -> dict | None:
    c = (e.get("competitions") or [{}])[0]
    comp = {x["homeAway"]: x for x in c.get("competitors", [])}
    if "home" not in comp or "away" not in comp:
        return None
    st = (c.get("status") or e.get("status") or {}).get("type", {})
    odds_list = c.get("odds") or []
    o = next((x for x in odds_list if "draft" in str((x.get("provider") or {}).get("name", "")).lower()), odds_list[0] if odds_list else None)

    def team(x):
        t = x["team"]
        sc = x.get("score")
        return {"id": str(t["id"]), "name": t.get("displayName") or t.get("name"), "abbr": t.get("abbreviation"),
                "score": int(float(sc)) if sc not in (None, "") else None}

    return {
        "id": f"{sport}:{e['id']}", "sport": sport, "start": e.get("date"), "state": st.get("state"), "completed": bool(st.get("completed")),
        "detail": st.get("detail"), "neutral": bool(c.get("neutralSite")), "home": team(comp["home"]), "away": team(comp["away"]),
        "now": _odds(o, "close") if o else None, "open": _odds(o, "open") if o else None,
    }


def scoreboard(sport: str, day: date) -> list[dict]:
    path, extra = SPORTS[sport]
    j = _get(f"{BASE}/{path}/scoreboard", {"dates": day.strftime("%Y%m%d"), **extra})
    out = []
    for e in j.get("events", []):
        p = parse_event(sport, e)
        if p:
            out.append(p)
    return out


def window(sports: list[str], back: int = 2, fwd: int = 3) -> list[dict]:
    """Every event from `back` days ago to `fwd` days ahead (ESPN's scoreboard day is the US-Eastern date)."""
    today = datetime.now(timezone.utc).date()
    jobs = [(s, today + timedelta(days=d)) for s in sports for d in range(-back, fwd + 1)]
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda a: scoreboard(*a), jobs))
    seen: dict[str, dict] = {}
    for r in res:
        for ev in r:
            seen[ev["id"]] = ev
    return list(seen.values())


def history(sport: str, days: int) -> list[dict]:
    """Finished games (home/away ids, scores, neutral flag, start) for the last `days` days, for fitting ratings."""
    today = datetime.now(timezone.utc).date()
    jobs = [(sport, today - timedelta(days=d)) for d in range(1, days + 1)]
    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(lambda a: scoreboard(*a), jobs))
    out = {}
    for r in res:
        for ev in r:
            if ev["completed"] and ev["home"]["score"] is not None and ev["away"]["score"] is not None:
                out[ev["id"]] = ev
    return sorted(out.values(), key=lambda e: e["start"])
