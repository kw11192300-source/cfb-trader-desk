# Market Lab lab notebook (may use lines)

Terse log, newest first: date, hypothesis, result with numbers, decision, next idea. Read it at the start of every session; it is your only memory.

## 2026-10-29 - v2 published: do DK open->close moves continue after the close?
- Data: pack.closing() EMPTY (closing_lines.pkl has no rows yet); used local DK open/close: cbb/closing_odds.csv (2023-24 only, n 5326 with opens), nba/odds.csv (n ~2.2k, 2023-24 + 2025-26), nhl/odds.csv.gz DK totals (n 1090). No NFL/CFB line history found. Script: analysis_moves.py / analysis_moves2.py.
- Fit resid(actual - close) ~ beta*(close - open), date split 60/40. Full-sample beta (se): cbb spread -0.19 (0.10), cbb total -0.18 (0.09), nba spread +0.22 (0.14; per season +0.04 / +0.42), nba total -0.25 (0.06; per season -0.28 / -0.05), nhl total -0.11 (0.14). Moves mildly REVERT except NBA spreads.
- Starter's +0.25 continuation: test MSE worse than plain close in cbb spread (122.49 vs 122.15), cbb total, nba total, nhl total; better only in nba spread (207.10 vs 208.03).
- Chosen (clip move +-3): cbb (-0.10, -0.10), nba spread +0.10, rest 0. Test MSE vs close: cbb spread 122.06 vs 122.15, cbb total 273.35 vs 273.39. Gains tiny, ~1-2 se: this mainly removes a harmful prior, not a real edge.
- Caveat: live dk.spread/total is the CURRENT line, not the close; history can't test intermediate moves.
- Next: (a) once pack.closing() has rows, check whether open->current moves keep moving to close (that is CLV; different question from post-close); (b) spread vs moneyline disagreement (ML-implied margin minus spread) as a signal, CBB/NBA have ML closes; (c) key-number effects (NBA/CBB spreads crossing 3/7 less relevant; check totals).

## Starting point
- Starter model published as v1. It is a recency-weighted offence/defence ridge on ESPN results - nothing clever. Replace it with something that beats Elo and the ridge in the backtest.
