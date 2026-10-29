"""Market Lab model: DraftKings line plus a small, per-sport/per-market adjustment for the open->current move.

v2 (2026-10-29): the starter pushed every move 25 % further. On historical DraftKings open/close lines (analysis_moves.py) that made
out-of-sample error worse in 4 of 5 markets. Full-sample move betas (resid after close ~ beta * move):
  cbb spread -0.19 (se 0.10, n 5326)   cbb total -0.18 (se 0.09, n 5326)   nba spread +0.22 (se 0.14, n 2216)
  nba total -0.25 (se 0.06, n 2307; unstable by season)   nhl total -0.11 (se 0.14, n 1090)   nfl/cfb: no data.
BETA below is roughly half of that where two date halves agree in sign, else 0. Moves are clipped to +-3 to blunt stale opens.
Caveat: history has only open and close; live, `spread`/`total` are the current line, which may still move before close.
"""
PORTABLE = True
BETA = {  # (spread, total)
    "cbb": (-0.10, -0.10),
    "nba": (0.10, 0.0),
}
CLIP = 3.0


def _clip(x):
    return max(-CLIP, min(CLIP, x))


def fit(pack):
    return {}


def predict(state, games):
    out = {}
    for g in games:
        d = g.get("dk")
        if not d or d.get("spread") is None or d.get("total") is None:
            continue
        bs, bt = BETA.get(g.get("sport"), (0.0, 0.0))
        m, t = -d["spread"], d["total"]
        if d.get("open_spread") is not None:
            m += bs * _clip(m - (-d["open_spread"]))
        if d.get("open_total") is not None:
            t += bt * _clip(t - d["open_total"])
        out[g["id"]] = [m, t]
    return out
