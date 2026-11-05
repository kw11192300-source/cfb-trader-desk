"""Round-to-round tracking of DraftKings' main lines, for the Line movement page.

Every round, each game DraftKings has priced is compared with the same game's views from the previous round. For each of its three main markets (spread, total, moneyline) this keeps:
  o / hi / lo   the opening value and the highest and lowest value seen since (the line number for a spread or total, DraftKings' no-vig price for the moneyline)
  ts            when it last moved
and writes an event whenever something moves, with the time:
  src "dk"      DraftKings moved: from, to, how far, where it stands against its open and its peak (a move back toward the open from a peak is a reversal), and whether the exchange
                was already pricing that way a round earlier (led)
  src "exch"    the exchange's price moved while DraftKings did not (the exchange moving first)
The events go into ex_meta "moves" (newest first, a day and a half) and the page turns them into a feed.
Values: a spread is the home team's number (a fall means the home side is laying more), a total is the number of points, the moneyline is the home win probability.
"""
from __future__ import annotations

from datetime import datetime, timedelta

MKTS = ("spread", "total", "ml")
TH = {"spread": 0.5, "total": 0.5, "ml": 0.015}  # smallest round-to-round change in DraftKings' number that is logged (points; for the moneyline, a share of a dollar)
TH_X = 0.02  # the exchange's price must move this much (2 cents) in a round, with DraftKings still, to log it
KEEP_HOURS = 36
MAX_ROWS = 600


def _imp(o: float | None) -> float | None:
    return None if o is None else (-o / (-o + 100) if o < 0 else 100 / (o + 100))


def devig(h: float | None, a: float | None) -> float | None:
    ph, pa = _imp(h), _imp(a)
    return None if ph is None or pa is None else ph / (ph + pa)


def open_values(ref_open: dict | None) -> dict:
    """The opening spread, total and moneyline (home win probability) from the game's stored opening line."""
    if not ref_open:
        return {}
    out = {"spread": ref_open.get("spread"), "total": ref_open.get("total"), "ml": devig(ref_open.get("ml_home"), ref_open.get("ml_away"))}
    return {k: v for k, v in out.items() if v is not None}


def _main(v: dict | None) -> dict:
    """{market: (line, DraftKings price, exchange price)} for the three main lines of a game's views."""
    out: dict = {}
    if not v or not v.get("lines") or not v.get("r"):
        return out
    xs = v.get("x") or [None] * len(v["lines"])
    for i, (kind, line) in enumerate(v["lines"]):
        if kind in MKTS:
            out[kind] = (line, v["r"][i], xs[i] if i < len(xs) else None)
    return out


def _val(m: str, t: tuple) -> float:
    return t[1] if m == "ml" else t[0]


def step(g: dict, old: dict | None, v: dict, now: datetime, open_vals: dict, span_min: float | None = None) -> tuple[dict, list[dict]]:
    """Update the tracker for one game: (new state, events). `old` and `v` are the game's views last round and this round."""
    if old is not None and (old.get("src") or "dk") != (v.get("src") or "dk"):
        old = None  # the game was on the exchange's own line a round ago and DraftKings has just priced it: that switch is not a DraftKings move, so start fresh
    prev_mv = (old or {}).get("mv") or {}
    cur, prev = _main(v), _main(old)
    ts = now.isoformat()
    teams = f"{g['away']['abbr']} @ {g['home']['abbr']}"
    state: dict = {}
    events: list[dict] = []
    for m, c in cur.items():
        val = _val(m, c)
        st = dict(prev_mv.get(m) or {})
        if "o" not in st:  # first time this market is tracked: its open (or the value it had a round ago), and the range includes where it was a round ago
            pv = _val(m, prev[m]) if m in prev else val
            st["o"] = open_vals.get(m, pv)
            st["hi"], st["lo"] = max(st["o"], val, pv), min(st["o"], val, pv)
        st["hi"], st["lo"] = max(st["hi"], val), min(st["lo"], val)
        p = prev.get(m)
        moved = False
        if p is not None:
            pval = _val(m, p)
            d = val - pval
            if abs(d) >= TH[m] - 1e-9:
                moved = True
                o, hi, lo = st["o"], st["hi"], st["lo"]
                ext = hi if abs(hi - o) >= abs(lo - o) else lo  # the furthest the market has been from its open
                toward_open = abs(val - o) < abs(pval - o)
                retrace = round(abs(ext - val), 3) if toward_open and abs(ext - o) > 1e-9 else 0.0
                # was the exchange already pricing this way? its gap to DraftKings a round earlier, signed so that positive means "toward the direction DraftKings then moved"
                gp = None
                if p[2] is not None and p[1] is not None:
                    gap = p[2] - p[1]  # the exchange's yes price minus DraftKings'
                    up = (d < 0) if m == "spread" else (d > 0)  # yes (home covers / over / home win) became more likely
                    gp = round((gap if up else -gap), 4)
                events.append({"ts": ts, "gid": g["id"], "sport": g["sport"], "teams": teams, "start": g["start_utc"], "mkt": m, "src": "dk", "frm": round(pval, 4), "to": round(val, 4), "d": round(d, 4),
                               "o": round(o, 4), "hi": round(hi, 4), "lo": round(lo, 4), "retrace": retrace, "gp": gp, "led": bool(gp is not None and gp >= 0.015), "span": span_min})
            elif p[2] is not None and c[2] is not None and abs(p[0] - c[0]) < 1e-9 and abs(c[2] - p[2]) >= TH_X - 1e-9:
                gap_now = c[2] - c[1]
                events.append({"ts": ts, "gid": g["id"], "sport": g["sport"], "teams": teams, "start": g["start_utc"], "mkt": m, "src": "exch", "frm": round(p[2], 4), "to": round(c[2], 4), "d": round(c[2] - p[2], 4),
                               "line": c[0], "dk": round(c[1], 4), "gap": round(gap_now, 4), "span": span_min})
        if moved:
            st["ts"], st["d"] = ts, round(val - _val(m, p), 4)
        st = {k: (round(x, 4) if isinstance(x, float) else x) for k, x in st.items()}
        state[m] = st
    return state, events


def merge(prior: list[dict], new: list[dict], now: datetime) -> list[dict]:
    """New events first, anything older than KEEP_HOURS dropped, capped."""
    cut = (now - timedelta(hours=KEEP_HOURS)).isoformat()
    return (sorted(new, key=lambda e: (e["ts"], abs(e.get("d", 0))), reverse=True) + [r for r in prior if r["ts"] >= cut])[:MAX_ROWS]
