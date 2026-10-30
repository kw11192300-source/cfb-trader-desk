"""Maker Lab quoting policy (paper money only).

The exchange calls quote(state, feats) once per round. For every contract this lab's market makers are about to quote, feats has one dict:
  k, sport, kind, line, hrs (hours to kickoff), ref (DraftKings fair), kal (Kalshi mid or None), eco (last exchange price or None), near (a line close to the main number),
  sens (price move per point of margin or total), sharp_net (contracts held by sharp accounts on this line, weighted by sharpness, positive = long yes),
  sharp_n (how many sharp accounts), pub_net (net contracts held by public money), syn_net (this syndicate's own net on the line), flow (how far sharp flow has moved the game's price), src
and the policy returns {k: {"shift": cents to move both quotes (positive = lean long), "half_bid": half-spread on the bid, "half_ask": ..., "size_bid": 0..2, "size_ask": 0..2,
"inv_scale": 0..1.5 (how hard the exchange leans quotes against inventory)}}. A contract left out is quoted with the trader's default.

v2: the lean toward sharp pressure is learned, not guessed. In the trade history the drift from DraftKings' price to the close grows with sharp-weighted net contracts
but saturates (0.19c per contract early in a line's life, ~0.05c once big positions have built up), so fit() fits lean = A * tanh(sharp_net / S) by least squares on a
small grid of S, shrinks A toward zero by sample size, and caps it. The lean is used only if, fitted on the earlier 60% of trades, it predicts the later 40% better than
no lean; otherwise the quotes stay centred on DraftKings and the sharp view is expressed only through a wider, smaller quote on the side sharps hit and a lower inventory lean.
(Replay 2026-10-30: every size of mid-lean lowered spread captured and move to the close, so on that history the gate keeps the lean at zero.)
"""
import math

PORTABLE = True

BASE_HALF = 0.013  # half-spread when nothing is known, about 1.3 cents each side
SHARP_MIN = 0.1  # same threshold the exchange uses to count a taker as sharp-weighted pressure
S_GRID = (5.0, 10.0, 20.0, 40.0)
A_CAP = 0.025  # never lean more than 2.5 cents on sharp pressure alone
SHRINK_N = 300  # the fitted lean keeps n / (n + SHRINK_N) of its size, so half at 300 trades
HOLDOUT = 0.6  # fit the lean on the first 60% of trades in time and keep it only if it helps on the rest


def _fit_lean(sn, drift):
    """Least-squares A and S for drift = A * tanh(sharp_net / S) over a small grid of S; None if there is no sharp pressure to fit."""
    best = None
    for s in S_GRID:
        x = [math.tanh(v / s) for v in sn]
        sxx = sum(v * v for v in x)
        if sxx <= 0:
            continue
        a = sum(xi * yi for xi, yi in zip(x, drift)) / sxx
        sse = sum((yi - a * xi) ** 2 for xi, yi in zip(x, drift))
        if best is None or sse < best[0]:
            best = (sse, a, s)
    return None if best is None else (best[1], best[2])


def _sharp_paths(df):
    """sharp_net known just before each trade, rebuilt the way the exchange builds it (earlier trades on the same game, kind and line)."""
    df = df.sort_values("ts")
    acc, out = {}, []
    for r in df.itertuples():
        k = (r.game_id, r.kind, r.line)
        out.append(acc.get(k, 0.0))
        if (not r.taker_public) and r.taker_sharp >= SHARP_MIN:
            acc[k] = acc.get(k, 0.0) + (1.0 if r.taker_buys else -1.0) * r.qty * r.taker_sharp
    return df, out


def fit(pack):
    state = {"base_half": BASE_HALF, "lean_a": 0.0, "lean_s": 20.0, "adv": {}, "n": 0}
    try:
        df = pack.trades()
    except Exception:
        df = None
    if df is None or not len(df):
        return state
    df = df[df["close_p"].notna() & df["ref_p"].notna()]
    if len(df) < 50:
        return state
    df, sn = _sharp_paths(df)
    drift = (df["close_p"] - df["ref_p"]).tolist()
    n = len(df)
    cut = int(n * HOLDOUT)
    tr = _fit_lean(sn[:cut], drift[:cut])
    # the lean is kept only if, fitted on the earlier trades, it predicts the later trades' drift to the close better than no lean at all
    if tr is not None:
        a, s = tr
        x = [math.tanh(v / s) for v in sn[cut:]]
        y = drift[cut:]
        gain = sum(yi * yi for yi in y) - sum((yi - a * xi) ** 2 for xi, yi in zip(x, y))
        state["lean_gain"] = gain
        full = _fit_lean(sn, drift)
        if gain > 0 and full is not None:
            state["lean_a"] = max(0.0, min(A_CAP, full[0] * n / (n + SHRINK_N)))  # only ever lean with the sharps, never against them
            state["lean_s"] = full[1]
    state["n"] = n
    sign = df["taker_buys"].map({True: 1.0, False: -1.0})
    clv = sign * (df["close_p"] - df["price"])
    for name, m in (("sharp", (~df["taker_public"]) & (df["taker_sharp"] >= 0.3)), ("public", df["taker_public"]), ("other", (~df["taker_public"]) & (df["taker_sharp"] < 0.3))):
        if m.sum() >= 20:
            state["adv"][name] = [float(clv[m].mean()), int(m.sum())]
    return state


def quote(state, feats):
    out = {}
    base = state.get("base_half", BASE_HALF)
    la, ls = state.get("lean_a", 0.0), state.get("lean_s", 20.0)
    for f in feats:
        sn, pn, hrs = f["sharp_net"], f["pub_net"], f["hrs"]
        half = base * (1.3 if hrs > 24 else 1.0 if hrs > 6 else 0.9)
        pressure = min(1.0, abs(sn) / 20.0)
        hb = ha = half
        sb = sa = 1.0
        # lean toward the sharp side by the learned, saturating amount, and make them pay on the side they hit
        shift = la * math.tanh(sn / ls)
        if sn > 0:
            ha += 0.004 * pressure
            sa = 1.0 - 0.5 * pressure
        elif sn < 0:
            hb += 0.004 * pressure
            sb = 1.0 - 0.5 * pressure
        # public money is the flow to earn the spread from: tighter and bigger on the side it is hitting
        if pn > 5:
            ha = max(0.008, ha - 0.002)
            sa = min(2.0, sa * 1.3)
        elif pn < -5:
            hb = max(0.008, hb - 0.002)
            sb = min(2.0, sb * 1.3)
        o = {"shift": shift, "half_bid": hb, "half_ask": ha, "size_bid": sb, "size_ask": sa, "inv_scale": 1.0 - 0.6 * pressure}
        if not f["near"] and hrs > 24:
            o["size_bid"] = o["size_ask"] = 0.0
        out[f["k"]] = o
    return out
