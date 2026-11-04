"""The ratings panel: outside college basketball rating systems (KenPom first) turned into a margin and a total on DraftKings' scale.

The Ratings Panel firm makes markets in college basketball games DraftKings has not priced yet, from this number. The same number seeds the exchange's opening line, so a game starts where the best
public ratings put it instead of where our own early-season ratings (squeezed toward the middle) do. Each system is fitted on its own to DraftKings' closing lines (margin = a + b * rating gap + c * home
court; total from the system's offence, defence and tempo), and the systems are averaged. Stored in ex_ratings under "cbb|panel", so the cloud runner reads it like any other rating.

    python -m exchange.panel backfill              give older line-discovery rows the systems' numbers, computed afterwards
    python -m exchange.panel load [--local] [--dry]        read python/data/cbb/benchmarks/*.csv, fit to the DraftKings closes held so far, store

Ratings go stale as the season runs: the panel's say fades with the age of the file (weight()), so an old file quietly stops mattering.
"""
from __future__ import annotations

import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

KEY = "cbb|panel"
BENCH = Path(__file__).resolve().parents[1] / "data" / "cbb" / "benchmarks"
SYSTEMS = ("kenpom", "torvik", "evanmiya")
FRESH_DAYS, DEAD_DAYS = 21, 60  # a rating file counts in full for three weeks, then fades to nothing by two months
MIN_GAMES = 60  # games needed to fit a system's line to DraftKings


def weight(payload: dict | None, today: date) -> float:
    """1.0 while the ratings are fresh, falling to 0 as the file ages."""
    if not payload:
        return 0.0
    age = (today - date.fromisoformat(payload["asof"])).days
    return float(np.clip(1.0 - (age - FRESH_DAYS) / (DEAD_DAYS - FRESH_DAYS), 0.0, 1.0))


def load_files(asof: str | None = None, bench: Path = BENCH) -> dict:
    """{system: {team_id: [net, off, def, tempo]}} from the benchmark csv files (KenPom's has tempo; Torvik's and EvanMiya's give net, off, def)."""
    from cbb_model.benchmarks import clean_key

    comp = pd.read_csv(bench / "comparison.csv")
    comp["team_id"] = comp["team_id"].astype(str)
    out: dict[str, dict] = {}
    kp = pd.read_csv(bench / "kenpom.csv")
    kp["key"] = kp["team"].map(clean_key)
    kp = kp.drop_duplicates("key").set_index("key")
    for s in SYSTEMS:
        col = f"{s}_net"
        if col not in comp:
            continue
        rows = {}
        for _, r in comp.dropna(subset=[col]).iterrows():
            tempo = float(kp.loc[r["key"], "tempo"]) if s == "kenpom" and r["key"] in kp.index else None
            rows[str(r["team_id"])] = [round(float(r[col]), 3), round(float(r[f"{s}_off"]), 3), round(float(r[f"{s}_def"]), 3), tempo]
        out[s] = rows
    stamp = asof or datetime.fromtimestamp((bench / "kenpom.csv").stat().st_mtime).date().isoformat()
    return {"asof": stamp, "systems": out}


def _gap(sys_rows: dict, h: str, a: str):
    rh, ra = sys_rows.get(h), sys_rows.get(a)
    return None if rh is None or ra is None else rh[0] - ra[0]


def _tot_x(sys_rows: dict, h: str, a: str, lg: dict):
    """KenPom-style total: each side's points per 100 from its offence against the other's defence, over the pace the two teams settle at."""
    rh, ra = sys_rows.get(h), sys_rows.get(a)
    if rh is None or ra is None or rh[3] is None or ra[3] is None:
        return None
    pace = rh[3] + ra[3] - lg["tempo"]
    return ((rh[1] + ra[2] - lg["eff"]) + (ra[1] + rh[2] - lg["eff"])) * pace / 100.0


def league(sys_rows: dict) -> dict:
    v = [r for r in sys_rows.values() if r[3] is not None]
    return {"eff": float(np.mean([r[1] for r in v])), "tempo": float(np.mean([r[3] for r in v]))} if v else {}


def fit(payload: dict, games: list[dict]) -> dict:
    """games: [{home_id, away_id, neutral, dk_m, dk_t}]. Adds payload['calib'] = per-system {m: [a, b, c], t: [a, b], n, miss}."""
    calib: dict[str, dict] = {}
    for s, rows in payload["systems"].items():
        X, y, home = [], [], []
        for g in games:
            d = _gap(rows, str(g["home_id"]), str(g["away_id"]))
            if d is not None:
                X.append(d); y.append(g["dk_m"]); home.append(0.0 if g.get("neutral") else 1.0)
        c = {"n": len(X)}
        if len(X) >= MIN_GAMES:
            A = np.column_stack([np.ones(len(X)), X, home])
            beta = np.linalg.lstsq(A, np.array(y), rcond=None)[0]
            c["m"] = [round(float(b), 4) for b in beta]
            c["miss"] = round(float(np.mean(np.abs(A @ beta - np.array(y)))), 3)
        calib[s] = c
    lg = league(payload["systems"].get("kenpom", {}))
    if lg:
        payload["league"] = {k: round(v, 3) for k, v in lg.items()}
        xs, ys = [], []
        for g in games:
            x = _tot_x(payload["systems"]["kenpom"], str(g["home_id"]), str(g["away_id"]), lg)
            if x is not None and g.get("dk_t"):
                xs.append(x); ys.append(g["dk_t"])
        if len(xs) >= MIN_GAMES:
            b, a = np.polyfit(xs, ys, 1)
            calib["kenpom"]["t"] = [round(float(a), 3), round(float(b), 4)]
            calib["kenpom"]["t_miss"] = round(float(np.mean(np.abs(a + b * np.array(xs) - np.array(ys)))), 3)
    payload["calib"] = calib
    return payload


def predict(payload: dict | None, home_id: str, away_id: str, neutral: bool, system: str | None = None) -> tuple[float, float | None, int] | None:
    """(margin, total or None, systems used): the average of every fitted system that rates both teams, or one system's own number (only KenPom has a total)."""
    if not payload or not payload.get("calib"):
        return None
    ms = []
    for s, rows in payload["systems"].items():
        if system and s != system:
            continue
        c = (payload["calib"].get(s) or {}).get("m")
        d = _gap(rows, str(home_id), str(away_id))
        if c and d is not None:
            ms.append(c[0] + c[1] * d + c[2] * (0.0 if neutral else 1.0))
    if not ms:
        return None
    t = None
    ct = (payload["calib"].get("kenpom") or {}).get("t")
    if ct and payload.get("league") and system in (None, "kenpom"):
        x = _tot_x(payload["systems"]["kenpom"], str(home_id), str(away_id), payload["league"])
        if x is not None:
            t = ct[0] + ct[1] * x
    return float(np.mean(ms)), t, len(ms)


def games_from_store(store) -> list[dict]:
    """The finished college basketball games with a DraftKings close, oriented as the exchange holds them."""
    neutral = {g["id"]: bool(g.get("neutral")) for g in store.rows("ex_games") if g["sport"] == "cbb"}
    out = []
    for r in store.rows("ex_results"):
        cl = r.get("closing")
        if r["sport"] != "cbb" or not cl or (cl.get("src") or "dk") != "dk":
            continue
        sp = [ln for k, ln in cl["lines"] if k == "spread"]
        tt = [ln for k, ln in cl["lines"] if k == "total"]
        if not sp:
            continue
        out.append({"home_id": r["home"]["id"], "away_id": r["away"]["id"], "neutral": neutral.get(r["id"], False), "dk_m": -float(sp[0]), "dk_t": float(tt[0]) if tt else None})
    return out


def build(games: list[dict]) -> dict:
    """Fit each system's line to DraftKings on the ratings as they stood before those games (the October snapshot, kept in benchmarks/oct13), then price games from the latest ratings: ratings
    updated after the games already played have those results in them, which would make the fit look worse than it is."""
    latest = load_files()
    snap = BENCH / "oct13"
    base = load_files(bench=snap) if (snap / "comparison.csv").exists() else latest
    payload = fit(base, games)
    payload["systems"] = latest["systems"]
    payload["asof"] = latest["asof"]
    lg = league(latest["systems"].get("kenpom", {}))
    if lg:
        payload["league"] = {k: round(v, 3) for k, v in lg.items()}
    return payload


def load(store) -> dict:
    payload = build(games_from_store(store))
    store.upsert("ex_ratings", [{"key": KEY, "payload": payload, "fitted_at": datetime.utcnow().isoformat() + "Z"}])
    # the ratings table is private; the panel scoreboard page reads this summary (as-of date and how well each system fitted DraftKings) from the public meta table
    store.upsert("ex_meta", [{"key": "panel", "value": {"asof": payload["asof"], "calib": {s: {k: v for k, v in c.items() if k in ("n", "miss", "t_miss")} for s, c in payload["calib"].items()}}}])
    store.save()
    return payload


def nums_for(payload: dict, home_id: str, away_id: str, neutral: bool) -> dict | None:
    """Each system's own margin and total for a game, and their average (what the scoreboard logs)."""
    out: dict = {}
    for sy in (None, *SYSTEMS):
        pp = predict(payload, home_id, away_id, neutral, sy)
        if pp:
            out[sy or "avg"] = [round(pp[0], 2), None if pp[1] is None else round(pp[1], 1)]
    return {**out, "asof": payload.get("asof")} if out else None


def backfill(store) -> int:
    """Line-discovery rows written before the panel existed get the systems' numbers computed afterwards from the current ratings, marked panel_bf so the page says so."""
    row = next((r for r in store.rows("ex_meta") if r["key"] == "discovery"), None)
    pay = next((r["payload"] for r in store.rows("ex_ratings") if r["key"] == KEY), None)
    if not row or not pay:
        return 0
    games = {g["id"]: g for g in store.rows("ex_games") if g["sport"] == "cbb"}
    n = 0
    for d in row["value"].get("rows", []):
        g = games.get(d["id"])
        if d["sport"] != "cbb" or isinstance(d.get("panel"), dict) or not g:
            continue
        nums = nums_for(pay, g["home"]["id"], g["away"]["id"], bool(g.get("neutral")))
        if nums:
            d["panel"], d["panel_bf"] = nums, True
            n += 1
    if n:
        store.upsert("ex_meta", [{"key": "discovery", "value": row["value"]}])
        store.save()
    return n


def main() -> None:
    from .store import FileStore, SbStore

    store = FileStore() if "--local" in sys.argv else SbStore()
    if "backfill" in sys.argv:
        print(f"{backfill(store)} line-discovery rows given the panel's numbers")
        return
    p = build(games_from_store(store)) if "--dry" in sys.argv else load(store)
    print(f"ratings as of {p['asof']}, {sum(len(v) for v in p['systems'].values())} team ratings across {list(p['systems'])}")
    for s, c in p["calib"].items():
        print(f"  {s:<9} games {c['n']:4d}" + (f" | margin = {c['m'][0]:+.2f} + {c['m'][1]:.3f} x gap + {c['m'][2]:+.2f} home | miss vs DraftKings {c['miss']:.2f}" if "m" in c else " | not fitted (too few games)") + (f" | total miss {c['t_miss']:.2f}" if "t_miss" in c else ""))


if __name__ == "__main__":
    main()
