"""Starter model for the Market Lab (may read market lines): does a DraftKings line move keep going?

It has no team ratings at all. When a line has moved since it opened, it predicts the game finishes a little further in the direction of the
move; with no move it agrees with DraftKings (so it has no edge and the exchange gives it no say). The lab's researcher is expected to learn
which moves continue, which revert, and in which sports, from the closing lines the exchange has been collecting (pack.closing()).
"""
PORTABLE = True
BETA = 0.25


def fit(pack):
    return {}


def predict(state, games):
    out = {}
    for g in games:
        d = g.get("dk")
        if not d or d.get("spread") is None or d.get("total") is None:
            continue
        m, t = -d["spread"], d["total"]
        if d.get("open_spread") is not None:
            m += BETA * (m - (-d["open_spread"]))
        if d.get("open_total") is not None:
            t += BETA * (t - d["open_total"])
        out[g["id"]] = [m, t]
    return out
