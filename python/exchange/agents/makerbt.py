"""Replay test for a maker lab's quoting policy against the trades the exchange has actually seen.

Every settled taker trade in the history is an order somebody sent into the market. For each one we ask what a policy would have quoted at that moment, using only what
was known just before it (earlier trades on the same game), and whether those quotes would have been hit:
  a taker who bought at price p is filled by the policy's ask when ask <= p (the policy's offer was at least as good as the one that traded)
  a taker who sold at price p is filled by the policy's bid when bid >= p
A fill is scored three ways: the edge against DraftKings' price at that moment (spread captured), the move to the closing price (negative means it was picked off), and the
profit against the final result. Policies are compared on the same trades, and the same table is shown for fixed-spread baselines.

Limits worth knowing: queue position, other makers reacting, and the extra volume a tighter quote would draw are not modelled; the policy's own inventory is not tracked
(the exchange's own inventory lean is applied on top when it runs live); the taker's sharpness is its current record, so the pressure features carry a small look-ahead.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd

from . import sandbox
from .pack import PACK_DIR

BASE_SIZE = 50.0  # contracts a policy offers on each side before its size multiplier
SHARP_MIN = 0.1


def features(df: pd.DataFrame) -> list[dict]:
    """One feature dict per trade, built only from trades that happened earlier on the same game, in time order."""
    feats: list[dict] = []
    sharp: dict[tuple, float] = {}
    pub: dict[tuple, float] = {}
    nsh: dict[tuple, int] = {}
    for r in df.itertuples():
        k = (r.game_id, r.kind, r.line)
        feats.append({"k": str(r.Index), "sport": r.sport, "kind": r.kind, "line": float(r.line), "hrs": float(r.hrs), "ref": float(r.ref_p), "kal": None, "eco": None, "near": True, "sens": None,
                      "sharp_net": sharp.get(k, 0.0), "sharp_n": nsh.get(k, 0), "pub_net": pub.get(k, 0.0), "syn_net": 0.0, "flow": 0.0, "src": "dk"})
        sign = 1.0 if r.taker_buys else -1.0
        if r.taker_public:
            pub[k] = pub.get(k, 0.0) + sign * r.qty
        elif r.taker_sharp >= SHARP_MIN:
            sharp[k] = sharp.get(k, 0.0) + sign * r.qty * r.taker_sharp
            nsh[k] = nsh.get(k, 0) + 1
    return feats


def score(df: pd.DataFrame, quotes: dict) -> dict:
    """Fills, spread captured, adverse selection and profit for one policy's quotes over the trades in df."""
    n = len(df)
    fills = contracts = 0.0
    edge = move = pnl = pnl2 = 0.0
    sharp_fills = sharp_move = 0.0
    nf = 0
    for r in df.itertuples():
        q = quotes.get(str(r.Index))
        if not q or r.close_p is None or (isinstance(r.close_p, float) and math.isnan(r.close_p)):
            continue
        sh, hb, ha = float(q.get("shift", 0.0)), float(q.get("half_bid", 0.012)), float(q.get("half_ask", 0.012))
        c = r.ref_p + float(np.clip(sh, -0.06, 0.06))
        ask, bid = min(0.99, math.ceil((c + ha) * 100 - 1e-9) / 100), max(0.01, math.floor((c - hb) * 100 + 1e-9) / 100)
        if r.taker_buys and ask <= r.price + 1e-9:
            size = min(r.qty, BASE_SIZE * float(np.clip(q.get("size_ask", 1.0), 0, 2)))
            e, m, p = ask - r.ref_p, ask - r.close_p, ask - r.outcome  # the maker sold at ask
        elif (not r.taker_buys) and bid >= r.price - 1e-9:
            size = min(r.qty, BASE_SIZE * float(np.clip(q.get("size_bid", 1.0), 0, 2)))
            e, m, p = r.ref_p - bid, r.close_p - bid, r.outcome - bid  # the maker bought at bid
        else:
            continue
        if size < 1:
            continue
        nf += 1
        fills += 1
        contracts += size
        edge += size * e
        move += size * m
        pnl += size * p
        pnl2 += size * size * p * p
        if (not r.taker_public) and r.taker_sharp >= 0.3:
            sharp_fills += size
            sharp_move += size * m
    c = max(contracts, 1e-9)
    return {"trades": n, "fills": int(fills), "contracts": round(contracts, 1), "edge": edge / c, "vs_close": move / c, "pnl_per": pnl / c, "pnl": pnl,
            "pnl_se": math.sqrt(pnl2) / c if contracts else 0.0, "sharp_share": sharp_fills / c, "sharp_vs_close": sharp_move / sharp_fills if sharp_fills else None}


def fixed(half: float, df: pd.DataFrame) -> dict:
    return {str(i): {"shift": 0.0, "half_bid": half, "half_ask": half, "size_bid": 1.0, "size_ask": 1.0} for i in df.index}


def run(code: str, root: Path = PACK_DIR, folds: int = 2) -> dict:
    f = Path(root) / "exchange_trades.pkl"
    if not f.exists():
        raise SystemExit("no trades in the pack: run `python -m exchange.agents pack` first")
    allt = pd.read_pickle(f)
    allt = allt[allt["outcome"].isin([0.0, 1.0]) & allt["close_p"].notna()].sort_values("ts").reset_index(drop=True)
    if len(allt) < 200:
        return {"error": f"only {len(allt)} settled trades with a closing price so far; the replay needs a few hundred"}
    cuts = [allt["ts"].quantile(q) for q in (np.linspace(0.55, 0.8, folds) if folds > 1 else [0.7])]
    rows: dict[str, list] = {"policy": [], "tight 1.0¢": [], "careful 1.7¢": [], "wide 3.0¢": []}
    for cut in cuts:
        test = allt[allt["ts"] >= cut].copy()
        test.index = test.index  # keep the original positions as keys
        feats = features(test)
        state = sandbox.call(code, "fit", timeout=900, pack={"root": str(root), "asof": str(cut), "lines_ok": True})
        out = sandbox.call(code, "quote", timeout=300, state=state, feats=feats)
        rows["policy"].append(score(test, out))
        rows["tight 1.0¢"].append(score(test, fixed(0.010, test)))
        rows["careful 1.7¢"].append(score(test, fixed(0.017, test)))
        rows["wide 3.0¢"].append(score(test, fixed(0.030, test)))
    res = {}
    for name, rs in rows.items():
        c = sum(r["contracts"] for r in rs) or 1e-9
        w = lambda key: sum(r[key] * r["contracts"] for r in rs) / c  # noqa: E731
        res[name] = {"fills": sum(r["fills"] for r in rs), "contracts": round(c, 1), "edge": w("edge"), "vs_close": w("vs_close"), "pnl_per": w("pnl_per"), "pnl": sum(r["pnl"] for r in rs),
                     "sharp_share": w("sharp_share"), "sharp_vs_close": (sum(r["sharp_vs_close"] * r["contracts"] * r["sharp_share"] for r in rs if r["sharp_vs_close"] is not None) /
                                                                         max(1e-9, sum(r["contracts"] * r["sharp_share"] for r in rs if r["sharp_vs_close"] is not None)))}
    res["_n_test"] = sum(r["trades"] for r in rows["policy"])
    return res


def table(res: dict) -> str:
    if "error" in res:
        return res["error"]
    lines = [f"replay over {res['_n_test']} settled taker trades (later folds of the history); edge = spread captured vs DraftKings at the time, vs close = move to the closing price (negative: picked off)",
             f"{'policy':<14}{'fills':>7}{'contracts':>11}{'edge':>9}{'vs close':>10}{'profit/contr':>14}{'total P&L':>11}{'sharp share':>13}{'sharp vs close':>16}"]
    for name, r in res.items():
        if name.startswith("_"):
            continue
        sv = "" if r["sharp_vs_close"] is None else f"{r['sharp_vs_close'] * 100:+.2f}¢"
        lines.append(f"{name:<14}{r['fills']:>7}{r['contracts']:>11}{r['edge'] * 100:>+8.2f}¢{r['vs_close'] * 100:>+9.2f}¢{r['pnl_per'] * 100:>+13.2f}¢{r['pnl']:>+11.1f}{r['sharp_share']:>12.0%}{sv:>16}")
    return "\n".join(lines)
