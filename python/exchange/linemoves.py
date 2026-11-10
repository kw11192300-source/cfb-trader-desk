"""Round-to-round tracking of DraftKings' main lines, for the Line movement page.

Every round, each game DraftKings has priced is compared with the same game's views from the previous round. For each of its three main markets (spread, total, moneyline) this keeps:
  o / hi / lo   the opening value and the highest and lowest value seen since (the line number for a spread or total, DraftKings' no-vig price for the moneyline)
  c / ts        the value the market is accepted to be at, and when it last moved
and writes an event whenever something moves, with the time:
  src "dk"      DraftKings moved (logged the round it is seen, settled the next: confirmed or bounced back): from, to, how far, where it stands against its open and its peak (a move back toward the
                open from a peak is a reversal), and whether the exchange was already pricing that way a round earlier (led)
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
BOUNCES = 2  # a market that has bounced back this many times in an hour has to hold a change for a round before the next one is logged


def _imp(o: float | None) -> float | None:
    return None if o is None else (-o / (-o + 100) if o < 0 else 100 / (o + 100))


def devig(h: float | None, a: float | None) -> float | None:
    ph, pa = _imp(h), _imp(a)
    return None if ph is None or pa is None else ph / (ph + pa)


def open_values(ref_open: dict | None, sport: str | None = None) -> dict:
    """The opening spread, total and moneyline (home win probability), as the market's price-implied margin and total when the sport is known (see _main)."""
    if not ref_open:
        return {}
    out = {"spread": ref_open.get("spread"), "total": ref_open.get("total"), "ml": devig(ref_open.get("ml_home"), ref_open.get("ml_away"))}
    if sport:
        try:
            from . import pricing

            d, _ = pricing.fit(sport, ref_open)
            if d:
                out["spread"], out["total"] = -round(d.m, 3), round(d.t, 3)
        except Exception:
            pass
    return {k: v for k, v in out.items() if v is not None}


def _main(v: dict | None) -> dict:
    """{market: (tracked value, DraftKings price, exchange price, rendered line)} for the three main lines of a game's views.

    The tracked value of a spread or total is the market's price-implied margin or total (views["rd"], the centre of the distribution fitted to DraftKings' line and prices), not the number ESPN renders:
    ESPN shows a whole-number DraftKings line (-9) as the half point on one side or the other (-9.5 at 48 cents, then -8.5 at 52 cents) and flips between them, which looks like a one-point move and is not
    one. The implied margin barely moves across the flip. A spread is written as the home team's number, so the implied margin of 9.0 is -9.0."""
    out: dict = {}
    if not v or not v.get("lines") or not v.get("r"):
        return out
    xs = v.get("x") or [None] * len(v["lines"])
    rd = v.get("rd")
    for i, (kind, line) in enumerate(v["lines"]):
        if kind in MKTS:
            val = line
            if rd and kind == "spread":
                val = -float(rd[0])
            elif rd and kind == "total":
                val = float(rd[1])
            out[kind] = (val, v["r"][i], xs[i] if i < len(xs) else None, line)
    return out


def _val(m: str, t: tuple) -> float:
    return t[1] if m == "ml" else t[0]


def step(g: dict, old: dict | None, v: dict, now: datetime, open_vals: dict, span_min: float | None = None) -> tuple[dict, list[dict], list[dict]]:
    """Update the tracker for one game: (new state, events, updates). `old` and `v` are the game's views last round and this round.

    A move is logged the moment a round sees it (ok False, "new"). The next round settles it: if the market held the new value the event is confirmed (an update sets ok), and if it went straight back it
    was a flicker (an update sets bounced). A market that has bounced twice in the last hour stops being logged instantly: its next change has to hold for a round first."""
    if old is not None and (old.get("src") or "dk") != (v.get("src") or "dk"):
        old = None  # the game was on the exchange's own line a round ago and DraftKings has just priced it: that switch is not a DraftKings move, so start fresh
    prev_mv = (old or {}).get("mv") or {}
    cur, prev = _main(v), _main(old)
    ts = now.isoformat()
    cut = (now - timedelta(minutes=60)).isoformat()
    teams = f"{g['away']['abbr']} @ {g['home']['abbr']}"
    state: dict = {}
    events: list[dict] = []
    updates: list[dict] = []
    for m, c in cur.items():
        if m == "spread" and g["sport"] == "nhl":
            continue  # a hockey puck line is always 1.5 and changes sign when the favourite switches: that is not a move (the moneyline shows the real one)
        val = _val(m, c)
        st = dict(prev_mv.get(m) or {})
        if st and not st.get("iv"):
            st = {}  # kept in the old units (the rendered line): start over in price-implied units
        st["iv"] = 1
        p = prev.get(m)
        pv = _val(m, p) if p is not None else val
        if "o" not in st:  # first time this market is tracked: its open (or the value it had a round ago), and the range includes where it was a round ago
            st["o"] = open_vals.get(m, pv)
            st["hi"], st["lo"] = max(st["o"], val, pv), min(st["o"], val, pv)
        base = st.get("c", pv)  # the value the market is accepted to be at
        # settle the move logged last round
        last = st.get("last")
        if last and not last.get("done"):
            key = {"gid": g["id"], "mkt": m, "ts": last["ts"]}
            if abs(val - last["frm"]) < TH[m] - 1e-9 and abs(val - last["to"]) >= TH[m] - 1e-9:  # straight back to where it was: a flicker
                updates.append({**key, "bounced": True})
                st["bn"] = [t for t in st.get("bn", []) if t >= cut] + [ts]
                base = val
            else:
                updates.append({**key, "ok": True})
            last["done"] = True
            st["last"] = last
        unstable = len([t for t in st.get("bn", []) if t >= cut]) >= BOUNCES
        moved = False
        if abs(val - base) >= TH[m] - 1e-9:
            pend = st.get("pend")
            if unstable and not (pend and (pend["v"] - base) * (val - base) > 0):
                st["pend"] = {"v": val, "ts": ts}  # a market that keeps flickering has to hold a change for a round before it is logged
            else:
                d = val - base
                o = st["o"]
                st["hi"], st["lo"] = max(st["hi"], val), min(st["lo"], val)
                hi, lo = st["hi"], st["lo"]
                ext = hi if abs(hi - o) >= abs(lo - o) else lo  # the furthest the market has been from its open
                toward_open = abs(val - o) < abs(base - o)
                retrace = round(abs(ext - val), 3) if toward_open and abs(ext - o) > 1e-9 else 0.0
                # was the exchange already pricing this way? its gap to DraftKings a round earlier, signed so that positive means "toward the direction DraftKings then moved"
                gp = None
                if p is not None and p[2] is not None and p[1] is not None:
                    gap = p[2] - p[1]  # the exchange's yes price minus DraftKings'
                    up = (d < 0) if m == "spread" else (d > 0)  # yes (home covers / over / home win) became more likely
                    gp = round((gap if up else -gap), 4)
                ets = pend["ts"] if (pend and unstable) else ts
                events.append({"ts": ets, "gid": g["id"], "sport": g["sport"], "teams": teams, "start": g["start_utc"], "mkt": m, "src": "dk", "frm": round(base, 4), "to": round(val, 4), "d": round(d, 4),
                               "o": round(o, 4), "hi": round(hi, 4), "lo": round(lo, 4), "retrace": retrace, "gp": gp, "led": bool(gp is not None and gp >= 0.015), "span": span_min, "ok": bool(unstable)})
                st["c"], st["ts"], st["d"] = val, ets, round(d, 4)
                if not unstable:
                    st["last"] = {"ts": ets, "frm": round(base, 4), "to": round(val, 4)}
                st.pop("pend", None)
                moved = True
        else:
            st.pop("pend", None)
            st["c"] = base
        if not moved and p is not None and p[2] is not None and c[2] is not None and abs(p[3] - c[3]) < 1e-9 and abs(c[2] - p[2]) >= TH_X - 1e-9 and abs(val - base) < TH[m] - 1e-9:
            events.append({"ts": ts, "gid": g["id"], "sport": g["sport"], "teams": teams, "start": g["start_utc"], "mkt": m, "src": "exch", "frm": round(p[2], 4), "to": round(c[2], 4), "d": round(c[2] - p[2], 4),
                           "line": c[3], "dk": round(c[1], 4), "gap": round(c[2] - c[1], 4), "span": span_min})
        st["hi"], st["lo"] = max(st["hi"], st.get("c", val)), min(st["lo"], st.get("c", val))
        st = {k: (round(x, 4) if isinstance(x, float) else x) for k, x in st.items()}
        state[m] = st
    return state, events, updates


def merge(prior: list[dict], new: list[dict], now: datetime, updates: list[dict] | None = None) -> list[dict]:
    """New events first, anything older than KEEP_HOURS dropped, capped. Updates settle events logged a round ago (confirmed, or bounced back)."""
    cut = (now - timedelta(hours=KEEP_HOURS)).isoformat()
    rows = sorted(new, key=lambda e: (e["ts"], abs(e.get("d", 0))), reverse=True) + [r for r in prior if r["ts"] >= cut]
    if updates:
        idx = {(u["gid"], u["mkt"], u["ts"]): u for u in updates}
        for r in rows:
            u = idx.get((r["gid"], r["mkt"], r["ts"]))
            if u and r.get("src") == "dk":
                if u.get("bounced"):
                    r["bounced"], r["ok"] = True, False
                elif u.get("ok"):
                    r["ok"] = True
    return rows[:MAX_ROWS]
