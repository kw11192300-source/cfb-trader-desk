"""Kalshi as a second reference price. Kalshi lists real-money winner, spread and total markets for the games the exchange trades; its public market data
needs no account. For each game we find the Kalshi event, translate its markets into our contracts (home wins, home covers at a half-point line, over),
and keep a mid price wherever both a bid and an ask are posted and they are reasonably tight."""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import requests

BASE = "https://api.elections.kalshi.com/trade-api/v2"
SERIES = {
    "nba": ("KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL"),
    "nhl": ("KXNHLGAME", "KXNHLSPREAD", "KXNHLTOTAL"),
    "nfl": ("KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"),
    "cfb": ("KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"),
    "cbb": ("KXNCAAMBGAME", "KXNCAAMBSPREAD", "KXNCAAMBTOTAL"),
}
MONTHS = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}
MAX_SPREAD = 0.10  # a mid is only used when the best bid and ask are within 10 cents


def _get(path: str, params: dict) -> dict:
    for _ in range(3):
        try:
            r = requests.get(BASE + path, params=params, headers={"User-Agent": "Mozilla/5.0"}, timeout=40)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
    return {}


def fetch_events(series: str) -> list[dict]:
    out, cursor = [], None
    for _ in range(6):
        j = _get("/events", {"series_ticker": series, "status": "open", "with_nested_markets": "true", "limit": 100, **({"cursor": cursor} if cursor else {})})
        out += j.get("events", [])
        cursor = j.get("cursor")
        if not cursor:
            break
    return out


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower())) - {"the", "of", "university", "state", "st"} | ({"state"} if "state" in s.lower() and len(re.findall(r"[a-z0-9]+", s)) <= 2 else set())


def _same_team(kalshi_name: str, espn_name: str) -> bool:
    k, e = _words(kalshi_name), _words(espn_name)
    return bool(k) and (k <= e or (len(k & e) >= 2 and len(k & e) >= len(k) - 1))


def parse_event(ev: dict) -> tuple[str, str, datetime] | None:
    """(away name, home name, date) from the event title 'A vs B: Spread' and its ticker date '26OCT29'."""
    m = re.match(r"^(.*?)\s+(?:vs\.?|at|@)\s+(.*?)(?::|$)", ev.get("title", ""))
    d = re.search(r"-(\d{2})([A-Z]{3})(\d{2})", ev.get("event_ticker", ""))
    if not m or not d or d.group(2) not in MONTHS:
        return None
    return m.group(1).strip(), m.group(2).strip(), datetime(2000 + int(d.group(1)), MONTHS[d.group(2)], int(d.group(3)))


def _price(m: dict, key: str) -> float | None:
    v = m.get(key)
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def translate(sport: str, ev: dict, kind: str, game: dict) -> list[list]:
    """Rows [kind, line, mid, bid, ask, volume] in OUR contract terms for one Kalshi event of one game."""
    away_name, home_name = game["away"]["name"], game["home"]["name"]
    rows = []
    for m in ev.get("markets", []):
        yb, ya = _price(m, "yes_bid_dollars"), _price(m, "yes_ask_dollars")
        if yb is None or ya is None or ya <= yb or ya - yb > MAX_SPREAD or yb <= 0 or ya >= 1:
            continue
        mid, vol = (yb + ya) / 2, _price(m, "volume_fp") or 0.0
        sub = (m.get("yes_sub_title") or m.get("title") or "")
        strike = m.get("floor_strike")
        if kind == "total":
            if strike is not None and "over" in sub.lower():
                rows.append(["total", float(strike), mid, yb, ya, vol])
        elif kind == "spread":
            if strike is None:
                continue
            side = re.match(r"^(.*?) wins by over", sub)
            if not side:
                continue
            f = float(strike)
            if _same_team(side.group(1), home_name):
                rows.append(["spread", -f, mid, yb, ya, vol])  # home wins by more than f  ==  home covers at -f
            elif _same_team(side.group(1), away_name):
                rows.append(["spread", f, 1 - mid, 1 - ya, 1 - yb, vol])  # away wins by more than f  ==  NOT (home covers at +f)
        else:  # winner
            who = re.match(r"^(.*?) wins", sub)
            if not who:
                continue
            if _same_team(who.group(1), home_name):
                rows.append(["ml", 0.0, mid, yb, ya, vol])
            elif _same_team(who.group(1), away_name):
                rows.append(["ml", 0.0, 1 - mid, 1 - ya, 1 - yb, vol])
    return rows


def fetch(games: dict[str, dict]) -> dict[str, list[list]]:
    """{exchange game id: [[kind, line, mid, bid, ask, volume], ...]} for every listed game Kalshi has markets on."""
    sports = sorted({g["sport"] for g in games.values()})
    jobs = [(sp, kind, ser) for sp in sports for kind, ser in zip(("ml", "spread", "total"), SERIES[sp])]
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda j: (j, fetch_events(j[2])), jobs))
    out: dict[str, list[list]] = {}
    for (sp, kind, _), events in res:
        for ev in events:
            p = parse_event(ev)
            if not p:
                continue
            away, home, day = p
            for gid, g in games.items():
                if g["sport"] != sp:
                    continue
                gd = datetime.fromisoformat(g["start_utc"].replace("Z", "+00:00")).replace(tzinfo=None) - timedelta(hours=5)  # ESPN's US-Eastern date
                if abs((gd.date() - day.date()).days) > 1:
                    continue
                if _same_team(away, g["away"]["name"]) and _same_team(home, g["home"]["name"]):
                    out.setdefault(gid, []).extend(translate(sp, ev, kind, g))
                    break
    return out
