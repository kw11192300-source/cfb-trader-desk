"""Walk-forward test of an agent's model on the ESPN results in the pack: fit on everything before a cut, predict the next block of games the model
has never seen, repeat, and score margin and total error against the coded baselines (Elo and the long-memory ridge) fitted on the same data and
against doing nothing (a flat home edge). The pack is truncated at each cut, so ESPN results cannot leak; files read through pack.path are on you."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import ratings
from . import sandbox
from .pack import Pack, PACK_DIR, SPORTS


def _games(df: pd.DataFrame) -> list[dict]:
    return [{"id": r.id, "sport": "", "home_id": r.home_id, "away_id": r.away_id, "home_name": r.home_name, "away_name": r.away_name,
             "neutral": bool(r.neutral), "start": r.start.isoformat(), "dk": None} for r in df.itertuples()]


def run(code: str, sports: list[str] | None = None, folds: int = 3, block: int = 120, timeout: int = 900, root=PACK_DIR) -> dict:
    sports = sports or SPORTS
    pack = Pack(root)
    out: dict[str, dict] = {}
    for sp in sports:
        g = pack.games(sp)
        blk = min(block, len(g) // (folds + 3))
        if blk < 40:
            out[sp] = {"skipped": f"only {len(g)} finished games"}
            continue
        err = {"model": [[], []], "elo": [[], []], "ridge": [[], []], "flat": [[], []]}
        covered = n = 0
        for f in range(folds):
            hi = len(g) - blk * (folds - 1 - f)
            test, train = g.iloc[hi - blk:hi], g.iloc[: hi - blk]
            cut = test["start"].min()
            try:
                state = sandbox.call(code, "fit", timeout=timeout, pack={"root": str(root), "asof": cut.isoformat(), "lines_ok": False})
                preds = sandbox.call(code, "predict", timeout=timeout, state=state, games=[{**x, "sport": sp} for x in _games(test)])
            except sandbox.ModelError as e:
                out[sp] = {"error": str(e)[-800:]}
                break
            tl = [{"id": r.id, "start": r.start.isoformat(), "neutral": r.neutral, "home": {"id": r.home_id, "score": r.home_score}, "away": {"id": r.away_id, "score": r.away_score}}
                  for r in train.itertuples()]
            base = {"elo": ratings.fit_elo(sp, tl), "ridge": ratings.fit_ridge(sp, tl, ratings.PARAMS[sp]["hl_long"], cut.timestamp() / 86400.0)}
            for r in test.itertuples():
                am, at = r.home_score - r.away_score, r.home_score + r.away_score
                n += 1
                p = (preds or {}).get(r.id)
                if p is not None:
                    covered += 1
                    err["model"][0].append(abs(am - p[0]))
                    err["model"][1].append(abs(at - p[1]))
                for name, eng in (("elo", "elo"), ("ridge", "ridge_long")):
                    b = ratings.predict(eng, base["elo" if name == "elo" else "ridge"], r.home_id, r.away_id, bool(r.neutral))
                    if b is not None:
                        err[name][0].append(abs(am - b[0]))
                        err[name][1].append(abs(at - b[1]))
                hca = 0.0 if r.neutral else ratings.PARAMS[sp]["hca"]
                err["flat"][0].append(abs(am - hca))
                err["flat"][1].append(abs(at - float(train.eval("home_score + away_score").mean())))
        if sp in out:
            continue
        out[sp] = {"n": n, "coverage": round(covered / max(1, n), 3),
                   **{k: {"margin_mae": round(float(np.mean(v[0])), 3) if v[0] else None, "total_mae": round(float(np.mean(v[1])), 3) if v[1] else None} for k, v in err.items()}}
    return out


def table(res: dict) -> str:
    lines = [f"{'sport':<5} {'n':>5} {'cover':>6} | margin MAE: {'model':>6} {'elo':>6} {'ridge':>6} {'flat':>6} | total MAE: {'model':>6} {'elo':>6} {'ridge':>6}"]
    for sp, r in res.items():
        if "skipped" in r or "error" in r:
            lines.append(f"{sp:<5} {r.get('skipped') or 'ERROR ' + r['error'][-300:]}")
            continue
        m = lambda k, i: f"{r[k]['margin_mae']:.2f}" if r[k]["margin_mae"] is not None else "-"  # noqa: E731
        t = lambda k: f"{r[k]['total_mae']:.2f}" if r[k]["total_mae"] is not None else "-"  # noqa: E731
        lines.append(f"{sp:<5} {r['n']:>5} {r['coverage']:>6.2f} | {'':>12}{m('model', 0):>6} {m('elo', 0):>6} {m('ridge', 0):>6} {m('flat', 0):>6} | {'':>11}{t('model'):>6} {t('elo'):>6} {t('ridge'):>6}")
    return "\n".join(lines)
