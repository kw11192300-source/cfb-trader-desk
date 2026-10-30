"""Everything an agent (or you) does with an agent syndicate's model: build the data pack, backtest a model file, publish it, refit it, read a report."""
from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .. import espn
from . import backtest as bt
from . import sandbox
from .pack import PACK_DIR, SPORTS, catalog, write_closing, write_games

MAX_STATE_MB = 6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- storage (ex_ratings keys, so no extra table)
def load(store, sid: str) -> tuple[dict | None, dict | None]:
    rows = {r["key"]: r["payload"] for r in store.rows("ex_ratings") if r["key"] in (f"agent-code:{sid}", f"agent-state:{sid}")}
    return rows.get(f"agent-code:{sid}"), rows.get(f"agent-state:{sid}")


def save_state(store, sid: str, state: dict) -> None:
    store.upsert("ex_ratings", [{"key": f"agent-state:{sid}", "payload": {"state": state, "fitted_at": _now()}, "fitted_at": _now()}])


def syndicate(store, sid: str) -> dict:
    s = next((x for x in store.rows("ex_syndicates") if x["id"] == sid), None)
    if not s or s["engine"] != "agent":
        raise SystemExit(f"{sid} is not an agent syndicate")
    s["learn"] = s.get("learn") or {}
    s["learn"].setdefault("agent", {"lines": False, "version": 0})
    return s


def lines_ok(s: dict) -> bool:
    return bool(s["learn"]["agent"].get("lines"))


# ---------------------------------------------------------------- pack
def build_pack(store, days: int = 420, sports: list[str] | None = None) -> None:
    for sp in sports or SPORTS:
        games = espn.history(sp, days)
        write_games(sp, games)
        print(f"  {sp}: {len(games)} finished games", flush=True)
    print(f"  closing lines for {write_closing(store)} watched games")
    catalog()
    print(f"pack ready in {PACK_DIR} (CATALOG.md lists the other data files)")


# ---------------------------------------------------------------- publish / refit
def _slate(store, sid: str, s: dict, limit: int = 120) -> list[dict]:
    out = []
    for g in store.rows("ex_games", {"completed": False}):
        if g["state"] != "pre" or not g.get("ref"):
            continue
        out.append(game_payload(g, lines_ok(s)))
    return out[:limit]


def game_payload(g: dict, lines: bool) -> dict:
    ref, op = g.get("ref") or {}, g.get("ref_open") or {}
    dk = ({"spread": ref.get("spread"), "total": ref.get("total"), "ml_home": ref.get("ml_home"), "ml_away": ref.get("ml_away"),
           "open_spread": op.get("spread"), "open_total": op.get("total"), "kalshi": (g.get("views") or {}).get("kal")} if lines else None)
    return {"id": g["id"], "sport": g["sport"], "home_id": g["home"]["id"], "away_id": g["away"]["id"], "home_name": g["home"]["name"], "away_name": g["away"]["name"],
            "neutral": bool(g.get("neutral")), "start": g["start_utc"], "dk": dk}


def check_predictions(preds: dict, slate: list[dict]) -> list[str]:
    problems = []
    for g in slate:
        p = preds.get(g["id"])
        if p is None:
            continue
        m, t = p
        lim = (12, 16) if g["sport"] == "nhl" else (80, 400)
        if not (np.isfinite(m) and np.isfinite(t)) or abs(m) > lim[0] or not (0 < t < lim[1]):
            problems.append(f"{g['id']}: implausible prediction margin {m} total {t}")
    return problems


def fit_and_store(store, sid: str, code: str, s: dict, *, timeout: int = 900, root: Path = PACK_DIR) -> dict:
    state = sandbox.call(code, "fit", timeout=timeout, pack={"root": str(root), "asof": None, "lines_ok": lines_ok(s)})
    blob = json.dumps(state)
    if len(blob) > MAX_STATE_MB * 1_000_000:
        raise SystemExit(f"state is {len(blob) / 1e6:.1f} MB; the limit is {MAX_STATE_MB} MB")
    save_state(store, sid, state)
    return state


def publish(store, sid: str, file: str, notes: str, skip_backtest: bool = False) -> None:
    s = syndicate(store, sid)
    code = Path(file).read_text(encoding="utf-8")
    meta = sandbox.call(code, "meta", timeout=60)
    if not (meta["has_fit"] and meta["has_predict"]):
        raise SystemExit("model must define fit(pack) and predict(state, games)")
    if not (PACK_DIR / "espn_nba.pkl").exists():
        print("building the data pack first...")
        build_pack(store)
    print("fitting on the full pack...", flush=True)
    state = fit_and_store(store, sid, code, s)
    slate = _slate(store, sid, s)
    preds = sandbox.call(code, "predict", timeout=300, state=state, games=slate) if slate else {}
    problems = check_predictions(preds, slate)
    cover = sum(1 for g in slate if g["id"] in preds) / max(1, len(slate))
    print(f"live slate: {len(slate)} games, {cover:.0%} covered, {len(problems)} problems")
    if problems:
        raise SystemExit("not published:\n" + "\n".join(problems[:10]))
    summary = None
    if not skip_backtest:
        print("backtesting (3 walk-forward folds per sport)...", flush=True)
        res = bt.run(code)
        print(bt.table(res))
        summary = {sp: {k: v for k, v in r.items() if k in ("n", "coverage", "model", "elo", "ridge", "error", "skipped")} for sp, r in res.items()}
    old, _ = load(store, sid)
    version = (old["version"] if old else 0) + 1
    history = ([{"v": version, "ts": _now(), "notes": notes}] + (old["history"] if old else []))[:25]
    store.upsert("ex_ratings", [{"key": f"agent-code:{sid}", "payload": {"code": code, "version": version, "notes": notes, "portable": meta["portable"], "history": history},
                                 "fitted_at": _now()}])
    s["learn"]["agent"].update(version=version, notes=notes, published_at=_now(), portable=meta["portable"], error=None, backtest=summary)
    store.upsert("ex_syndicates", [s])
    store.save()
    print(f"published {sid} v{version}")


def refit(store, sid: str, only_portable: bool = False, root: Path = PACK_DIR) -> bool:
    s = syndicate(store, sid)
    payload, _ = load(store, sid)
    if not payload:
        print(f"{sid}: no model published yet")
        return False
    if only_portable and not payload.get("portable"):
        return False
    try:
        fit_and_store(store, sid, payload["code"], s, root=root)
        s["learn"]["agent"]["error"] = None
        ok = True
    except (sandbox.ModelError, SystemExit) as e:
        s["learn"]["agent"]["error"] = str(e)[-300:]
        ok = False
    s["learn"]["agent"]["refit_at"] = _now()
    store.upsert("ex_syndicates", [s])
    store.save()
    print(f"{sid}: refit {'ok' if ok else 'FAILED: ' + s['learn']['agent']['error']}")
    return ok


def refit_portable(store, hist: dict[str, list[dict]]) -> None:
    """Hosted job: refit every agent model that learns from ESPN results alone, using the histories just fetched."""
    ids = [x["id"] for x in store.rows("ex_syndicates") if x["engine"] == "agent"]
    if not ids:
        return
    with tempfile.TemporaryDirectory(prefix="pack_") as d:
        from .pack import write_games as wg

        for sp, games in hist.items():
            wg(sp, games, Path(d))
        for sid in ids:
            refit(store, sid, only_portable=True, root=Path(d))


# ---------------------------------------------------------------- report
def report(store, sid: str) -> None:
    s = syndicate(store, sid)
    a = s["learn"]["agent"]
    ms = [m for m in store.rows("ex_members") if m["syndicate_id"] == sid]
    trades = [t for t in store.rows("ex_trades") if t["buyer"].startswith(sid + "-") or t["seller"].startswith(sid + "-")]
    print(f"== {s['name']} ({sid})  model v{a.get('version', 0)}  mandate: {'may use market lines' if a.get('lines') else 'market-blind'}")
    print(f"notes: {a.get('notes')}   published: {a.get('published_at')}   last error: {a.get('error')}")
    eq = sum(m.get("equity") or m["cash"] + m["locked"] for m in ms)
    cn = sum(m["stats"]["clv_n"] for m in ms)
    print(f"equity {eq:.1f} (start {s['start_units']:.0f}); settled P&L {sum(m['realized'] for m in ms):+.1f}; trades {len(trades)}; CLV {sum(m['stats']['clv_sum'] for m in ms) / cn * 100:+.2f}c over {cn} settled sides" if cn else
          f"equity {eq:.1f} (start {s['start_units']:.0f}); trades {len(trades)}; no settled trades yet (CLV appears after games finish)")
    st = (s["learn"].get("stats") or {})
    w = s["learn"].get("w") or {}
    print("model weight by sport (how much of its view reaches prices) and settled-game evidence:")
    for sp in SPORTS:
        x = st.get(sp, {"n": 0, "num": 0, "den": 0})
        print(f"  {sp}: weight {w.get(sp, 0.25):.2f}   lines scored {x['n']}   edge-vs-market score {x['num']:+.3f} on {x['den']:.3f}")
    # the real test: the lab's own price for each finished game's moneyline, main spread and main total, against what happened, next to DraftKings' closing price on the same lines
    sc: dict[str, list[float]] = {}
    for r in store.rows("ex_results"):
        c = r.get("closing")
        if not c or (c.get("src") or "dk") != "dk" or sid not in (c.get("e") or {}):
            continue
        for i, y in enumerate(c["y"]):
            e = c["e"][sid]
            if y != 0.5 and i < len(e) and e[i] is not None and c["dk"][i] is not None:
                sc.setdefault(r["sport"], []).append((c["dk"][i] - y) ** 2 - (e[i] - y) ** 2)
    print("scored against the market on finished games (your price vs DraftKings' close, Brier; positive means you were closer to what happened):")
    if not sc:
        print("  nothing yet: closing prices are recorded as games finish")
    for sp, d in sc.items():
        n = len(d)
        m = sum(d) / n
        se = (sum((x - m) ** 2 for x in d) / (n - 1) / n) ** 0.5 if n > 2 else 0.0
        print(f"  {sp}: {n} prices, {m * 1000:+.2f} per 1000" + (f" (z {m / se:+.1f})" if se > 0 else "") + ("  - within noise" if se > 0 and abs(m / se) < 2 else ""))
    if a.get("backtest"):
        print("last backtest (margin MAE: model / elo / ridge):")
        for sp, r in a["backtest"].items():
            if "model" in r:
                print(f"  {sp}: {r['model']['margin_mae']} / {r['elo']['margin_mae']} / {r['ridge']['margin_mae']}   total {r['model']['total_mae']} / {r['elo']['total_mae']} / {r['ridge']['total_mae']}  coverage {r['coverage']}")
