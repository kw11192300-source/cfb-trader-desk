"""Maker Lab quoting policy (paper money only).

The exchange calls quote(state, feats) once per round. For every contract this lab's market makers are about to quote, feats has one dict:
  k, sport, kind, line, hrs (hours to kickoff), ref (DraftKings fair), kal (Kalshi mid or None), eco (last exchange price or None), near (a line close to the main number),
  sens (price move per point of margin or total), sharp_net (contracts held by sharp accounts on this line, weighted by sharpness, positive = long yes),
  sharp_n (how many sharp accounts), pub_net (net contracts held by public money), syn_net (this syndicate's own net on the line), flow (how far sharp flow has moved the game's price), src
and the policy returns {k: {"shift": cents to move both quotes (positive = lean long), "half_bid": half-spread on the bid, "half_ask": ..., "size_bid": 0..2, "size_ask": 0..2,
"inv_scale": 0..1.5 (how hard the exchange leans quotes against inventory)}}. A contract left out is quoted with the trader's default.
"""
PORTABLE = True

BASE_HALF = 0.013  # half-spread when nothing is known, about 1.3 cents each side


def fit(pack):
    """Learns from the settled trades: how much each kind of taker's fills move against a maker (closing price minus fill price, in the taker's favour)."""
    state = {"base_half": BASE_HALF, "sharp_shift": 0.0015, "adv": {}}
    try:
        df = pack.trades()
    except Exception:
        df = None
    if df is not None and len(df):
        df = df[df["close_p"].notna()]
        sign = df["taker_buys"].map({True: 1.0, False: -1.0})
        clv = sign * (df["close_p"] - df["price"])  # what the taker gained against the close, per contract
        for name, m in (("sharp", (~df["taker_public"]) & (df["taker_sharp"] >= 0.3)), ("public", df["taker_public"]), ("other", (~df["taker_public"]) & (df["taker_sharp"] < 0.3))):
            if m.sum() >= 20:
                state["adv"][name] = [float(clv[m].mean()), int(m.sum())]
    return state


def quote(state, feats):
    out = {}
    base = state.get("base_half", BASE_HALF)
    ks = state.get("sharp_shift", 0.0015)
    for f in feats:
        sn, pn, hrs = f["sharp_net"], f["pub_net"], f["hrs"]
        half = base * (1.3 if hrs > 24 else 1.0 if hrs > 6 else 0.9)
        pressure = min(1.0, abs(sn) / 20.0)
        hb = ha = half
        sb = sa = 1.0
        # where the sharp accounts are: lean the quotes toward them (so the lab builds a position on their side), but make them pay on the side they hit
        shift = max(-0.03, min(0.03, ks * sn))
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
