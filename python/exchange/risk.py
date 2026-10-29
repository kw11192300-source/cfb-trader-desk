"""Worst-case risk for a trader's positions in one game.

A contract's value depends on the final margin (moneyline and spread contracts) or the final total (total contracts). A position's profit
at every margin and every total is a step function that only changes at the lines that were traded, so evaluating just either side of each
line covers every possible result. The risk of a position is the most it can lose across those results - not the collateral posted, so a
hedged position (long and short the same line, or a ladder that offsets) shows little risk even though cash is tied up on both legs.
"""
from __future__ import annotations

import numpy as np

BIG = 1e3


class Grid:
    """The evaluation points for one game: margins for moneyline/spread contracts, totals for total contracts."""

    def __init__(self, lines: set[tuple[str, float]]):
        mt, tt = {0.0}, set()
        for kind, line in lines:
            if kind == "spread":
                mt.add(-line)
            elif kind == "total":
                tt.add(line)
        self.mx = np.array(sorted({t + d for t in mt for d in (-0.25, 0.25)} | {-BIG, BIG}))
        self.tx = np.array(sorted({t + d for t in tt for d in (-0.25, 0.25)} | {-BIG, BIG}))
        self._c: dict[tuple[str, float], tuple[str, np.ndarray]] = {}

    def outcome(self, kind: str, line: float) -> tuple[str, np.ndarray]:
        """('m' | 't', 1.0 where the 'yes' side of the contract wins) at each grid point."""
        key = (kind, line)
        if key not in self._c:
            if kind == "ml":
                self._c[key] = ("m", (self.mx > 0).astype(float))
            elif kind == "spread":
                self._c[key] = ("m", (self.mx + line > 0).astype(float))
            else:
                self._c[key] = ("t", (self.tx > line).astype(float))
        return self._c[key]


def position_vectors(grid: Grid, lots: list[tuple[str, float, float, float]]) -> tuple[np.ndarray, np.ndarray]:
    """Profit at every grid point from open lots [(kind, line, signed qty, price)] - positive qty is long yes, negative is short."""
    vm, vt = np.zeros(len(grid.mx)), np.zeros(len(grid.tx))
    for kind, line, q, px in lots:
        dim, ov = grid.outcome(kind, line)
        pnl = q * (ov - px)  # long: q*(out - px); short (q<0): |q|*(px - out)
        if dim == "m":
            vm += pnl
        else:
            vt += pnl
    return vm, vt


def worst(v: np.ndarray) -> float:
    return float(max(0.0, -v.min()))


def room(v: np.ndarray, u: np.ndarray, limit: float) -> float:
    """The most contracts q that can be added (profit per contract at each grid point is u) with the worst case staying within `limit`."""
    neg = u < 0
    if not neg.any():
        return float("inf")
    return max(0.0, float(np.min((v[neg] + limit) / -u[neg])))
