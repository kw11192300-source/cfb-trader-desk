"""
The official NBA injury report (published as a PDF every 15 minutes, https://official.nba.com/nba-injury-report-2025-26-season/):
fetch the newest one, parse it into one row per player per game, and optionally compare with ESPN's injury feed.

The PDF is a table - GameDate | GameTime | Matchup | Team | PlayerName | CurrentStatus | Reason - where the game, time and team
cells appear only on the first row they apply to, and a long reason wraps onto lines above AND below its player row. So the
parse works on word positions, not lines: columns come from x, context (date/time/matchup/team) carries down the page and across
pages, and each reason line goes to the nearest player row.

    python -m nba_model.injuries latest                    # newest report, parsed
    python -m nba_model.injuries test 2026-03-15           # parse every report of a past day, sanity-check
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import re
from zoneinfo import ZoneInfo

import pandas as pd
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://official.nba.com/",
}
BASE = "https://ak-static.cms.nba.com/referee/injury"
ET = ZoneInfo("America/New_York")

# x ranges of the columns (points), from the header row of the PDF
COLS = [("date", 0, 100), ("time", 100, 190), ("matchup", 190, 255), ("team", 255, 415), ("player", 415, 580), ("status", 580, 660), ("reason", 660, 9999)]
STATUSES = {"Out", "Doubtful", "Questionable", "Probable", "Available"}
HEADER_WORDS = {"GameDate", "GameTime", "Matchup", "Team", "PlayerName", "CurrentStatus", "Reason"}
TIME_RE = re.compile(r"^\d{2}:\d{2}\(ET\)$")
DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
MATCH_RE = re.compile(r"^[A-Z]{2,3}@[A-Z]{2,3}$")


def report_url(t: dt.datetime) -> str:
    """The report for an Eastern-time moment on a 15-minute mark, e.g. 2026-10-20 13:15 -> ..._2026-10-20_01_15PM.pdf"""
    return f"{BASE}/Injury-Report_{t:%Y-%m-%d}_{t:%I_%M%p}.pdf"


def latest_report(now: dt.datetime | None = None, back_hours: int = 6) -> tuple[bytes, dt.datetime] | None:
    """Walk back from now in 15-minute steps to the newest report that exists."""
    now = (now or dt.datetime.now(ET)).astimezone(ET)
    t = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
    for _ in range(back_hours * 4):
        r = requests.get(report_url(t), headers=HEADERS, timeout=30)
        if r.status_code == 200 and r.content[:4] == b"%PDF":
            return r.content, t
        t -= dt.timedelta(minutes=15)
    return None


def _col(x: float) -> str:
    for name, lo, hi in COLS:
        if lo <= x < hi:
            return name
    return "reason"


def _name(s: str) -> str:
    """'Carter,Devin' -> 'Devin Carter'; 'PorterJr.,Michael' -> 'Michael Porter Jr.'"""
    last, _, first = s.partition(",")
    last = re.sub(r"(Jr\.|Sr\.|II|III|IV)$", lambda m: " " + m.group(1), last)
    first = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", first)
    last = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", last)
    return f"{first} {last}".strip()


def _split_camel(s: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s).replace("/", " / ")


def _team_name(s: str) -> str:
    """'BostonCeltics' -> 'Boston Celtics'; 'LAClippers' -> 'LA Clippers'; 'PortlandTrailBlazers' -> 'Portland Trail Blazers'"""
    s = re.sub(r"^(LA)(?=[A-Z])", r"\1 ", s)
    return re.sub(r"(?<=[a-z])(?=\d)", " ", _split_camel(s))


def parse_pdf(content: bytes, report_time: dt.datetime | None = None) -> pd.DataFrame:
    import pdfplumber

    rows: list[dict] = []
    ctx = {"date": None, "time": None, "matchup": None, "team": None}
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=False, use_text_flow=False)
            # the title line ("Injury Report: <time>") sits at the top of every page, the column header row only on page 1, and a
            # "Page 1 of 3" footer at the bottom - none of them are data
            words = [w for w in words if w["top"] > 60 and not w["text"].startswith("Page") and not (100 < w["top"] < 118 and w["text"] in HEADER_WORDS)]
            # group into visual rows
            words.sort(key=lambda w: (round(w["top"]), w["x0"]))
            groups: list[list[dict]] = []
            for w in words:
                if groups and abs(w["top"] - groups[-1][0]["top"]) <= 3:
                    groups[-1].append(w)
                else:
                    groups.append([w])
            anchors: list[dict] = []
            reason_words: list[tuple[float, str]] = []
            for g in groups:
                cells: dict[str, list[str]] = {}
                for w in g:
                    cells.setdefault(_col(w["x0"]), []).append(w["text"])
                top = g[0]["top"]
                for w in g:
                    if _col(w["x0"]) == "reason":
                        top_r = w["top"]
                if "date" in cells and DATE_RE.match(cells["date"][0]):
                    ctx["date"] = cells["date"][0]
                if "time" in cells and TIME_RE.match(cells["time"][0]):
                    ctx["time"] = cells["time"][0]
                if "matchup" in cells and MATCH_RE.match(cells["matchup"][0]):
                    ctx["matchup"] = cells["matchup"][0]
                if "team" in cells:
                    ctx["team"] = "".join(cells["team"])
                player = " ".join(cells.get("player", []))
                status = " ".join(cells.get("status", []))
                reason = " ".join(cells.get("reason", []))
                if player and "," in player:
                    anchors.append({**ctx, "top": top, "player_raw": player, "status": status if status in STATUSES else status, "reason_parts": []})
                    if reason:
                        reason_words.append((top, reason))
                elif reason.replace(" ", "").upper() == "NOTYETSUBMITTED" or (player.replace(" ", "").upper() == "NOTYETSUBMITTED"):
                    anchors.append({**ctx, "top": top, "player_raw": None, "status": "NOT YET SUBMITTED", "reason_parts": []})
                elif reason:
                    reason_words.append((top, reason))
            for top, text in reason_words:  # a wrapped reason line belongs to the nearest player row
                if not anchors:
                    continue
                a = min(anchors, key=lambda x: abs(x["top"] - top))
                a["reason_parts"].append((top, text))
            for a in anchors:
                raw = " ".join(t for _, t in sorted(a["reason_parts"])).strip()
                cat, _, detail = raw.partition("-")
                rows.append(
                    {
                        "game_date": a["date"], "game_time_et": a["time"], "matchup": a["matchup"], "team": _team_name(a["team"] or ""),
                        "player": _name(a["player_raw"]) if a["player_raw"] else None, "status": a["status"],
                        "reason_cat": _split_camel(cat).replace(" / ", "/").strip() or None, "reason_detail": _split_camel(detail).strip() or None,
                    }
                )
    df = pd.DataFrame(rows)
    if report_time is not None and len(df):
        df.insert(0, "report_time", report_time.isoformat())
    return df


def fetch_latest() -> pd.DataFrame:
    got = latest_report()
    if not got:
        return pd.DataFrame()
    content, t = got
    return parse_pdf(content, t)


def espn_injuries() -> pd.DataFrame:
    j = requests.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries", headers=HEADERS, timeout=30).json()
    rows = []
    for t in j.get("injuries", []):
        for i in t.get("injuries", []):
            a = i.get("athlete") or {}
            rows.append({"team": t.get("displayName"), "player": a.get("displayName"), "espn_id": a.get("id"), "status": i.get("status"), "date": i.get("date"),
                         "detail": (i.get("details") or {}).get("detail") or (i.get("details") or {}).get("type"), "return": (i.get("details") or {}).get("returnDate"),
                         "comment": i.get("shortComment")})
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["latest", "test"])
    ap.add_argument("day", nargs="?")
    a = ap.parse_args()
    if a.what == "latest":
        df = fetch_latest()
        print(f"{len(df)} rows; report {df['report_time'].iloc[0] if len(df) else None}")
        print(df.to_string(index=False, max_rows=60))
    else:
        d = dt.date.fromisoformat(a.day)
        bad = 0
        for h in (11, 14, 17, 19):
            t = dt.datetime(d.year, d.month, d.day, h, 30, tzinfo=ET)
            r = requests.get(report_url(t), headers=HEADERS, timeout=30)
            if r.status_code != 200:
                print(t, "missing")
                continue
            df = parse_pdf(r.content, t)
            players = df[df["player"].notna()]
            print(f"{t:%H:%M}: {len(df)} rows, {len(players)} players, statuses {players['status'].value_counts().to_dict()}, games {df['matchup'].nunique()}, no-reason {players['reason_cat'].isna().sum()}, bad-status {(~players['status'].isin(STATUSES)).sum()}")


if __name__ == "__main__":
    main()
