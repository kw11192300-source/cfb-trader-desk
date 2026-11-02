# Market Lab lab notebook (may use lines)

Terse log, newest first: date, hypothesis, result with numbers, decision, next idea. Read it at the start of every session; it is your only memory.

## 2026-11-01 - v4 published: NHL priced from the moneyline, not the puckline
- Report: equity 9415, CLV +1.27c over 2177 sides. vs DK close (Brier/1000): nhl -20.4 (87, z -1.7), nba -2.3 (69, z -2.0), cbb -8.1 (6), cfb -1.0 (156), nfl +1.8 (39).
- Why NHL lost: the engine prices from Dist(m, t) (Skellam for NHL); v1-v3 returned m = -spread = +-1.5 for every game, so every favourite was a 1.5-goal favourite. dk carries no puckline/over-under prices, only numbers and ML.
- Fix (_nhl_mt): t = Poisson mean with P(over L) = 0.5; m = value reproducing the no-vig ML under the engine's Skellam. Script analysis_nhl_ml.py (arg = book).
- DK closes 2023-24 n 1302 (own totals only 92): ML Brier 250.1 -> 232.2 (A-B +17.9, se 3.6), puckline 248.5 -> 233.7 (+14.8, se 3.6), both halves; engine full-price fit 232.3 (equal). Totals -3.1 (se 3.0, n 92).
- ESPN BET n 4222: puckline +12.3 (se 1.8); totals +0.2 (se 0.5, n 3001). Its ML/engine-fit columns look corrupt (fit m corr 0.05 with ML m) - ignore. Live 29 watched NHL games: ML +16 (se 28).
- No parameters fitted, so this is a correction rather than an edge: it brings NHL back level with DK's own prices. Published v4; other sports unchanged.
- Next: (a) NHL edge on top of the fixed baseline: Kalshi total/ML vs DK (29 games in pack.closing, needs ~150); (b) NBA is -2.3/1000 (z -2.0): check whether the ML-gap/move nudges hurt live - recompute on pack.closing nba (24 rows) and consider setting nba betas to 0; (c) totals analogue of the ML gap (from v3 notes).

## 2026-10-30 - v3 published: moneyline vs spread disagreement
- pack.closing() now has 17 watched games: still far too few to use. Live record so far: CLV -0.08c over 303 settled sides; NHL edge score -0.182 on 33 lines (model is ~market there; nothing labm-specific in NHL).
- gap = margin implied by no-vig DK closing ML (probit, cubic map from spread) minus spread margin; fit resid(actual - close) ~ beta*gap. Scripts: analysis_mlspread.py (linear sigma map), analysis_mlspread2.py (cubic map, per season).
- CBB n 10400 (2022-23, 2023-24): per season +0.31 (se 0.18), +0.25 (0.16); 60/40 date split train +0.20, test +0.44 (0.21). |spread|<=6 subset flips sign in 2024 (-0.46, se 0.53) - noise or the effect lives at mid/large spreads.
- NBA n 2307: per season +0.94 (0.60), +0.11 (0.54); test +0.08 (0.56). Same sign, noise. Brier straight-up: ML vs spread equal in CBB, ML slightly better in NBA (0.1925 vs 0.1934).
- Shipped beta cbb 0.25, nba 0.15, gap clip +-2, skip p outside 3-97 % or |spread|>20. Late-40 % MSE: cbb 122.60 -> 122.48 (n 4160), nba 204.72 -> 204.65 (n 923). Mean nudge 0.1 pt. ~2 se in CBB, i.e. small but real-looking; caveat: cubic map fit on all data (calibration only).
- Next: (a) the totals analogue - does the total/ML/spread triangle imply anything for totals (fav ML price vs total)? (b) once pack.closing() has ~200 rows: open->current vs close (CLV) and Kalshi-vs-DK disagreement as a signal; (c) NHL: only market with real settled volume - test DK total vs Kalshi or ML-implied total.

## 2026-10-29 - v2 published: do DK open->close moves continue after the close?
- Data: pack.closing() EMPTY (closing_lines.pkl has no rows yet); used local DK open/close: cbb/closing_odds.csv (2023-24 only, n 5326 with opens), nba/odds.csv (n ~2.2k, 2023-24 + 2025-26), nhl/odds.csv.gz DK totals (n 1090). No NFL/CFB line history found. Script: analysis_moves.py / analysis_moves2.py.
- Fit resid(actual - close) ~ beta*(close - open), date split 60/40. Full-sample beta (se): cbb spread -0.19 (0.10), cbb total -0.18 (0.09), nba spread +0.22 (0.14; per season +0.04 / +0.42), nba total -0.25 (0.06; per season -0.28 / -0.05), nhl total -0.11 (0.14). Moves mildly REVERT except NBA spreads.
- Starter's +0.25 continuation: test MSE worse than plain close in cbb spread (122.49 vs 122.15), cbb total, nba total, nhl total; better only in nba spread (207.10 vs 208.03).
- Chosen (clip move +-3): cbb (-0.10, -0.10), nba spread +0.10, rest 0. Test MSE vs close: cbb spread 122.06 vs 122.15, cbb total 273.35 vs 273.39. Gains tiny, ~1-2 se: this mainly removes a harmful prior, not a real edge.
- Caveat: live dk.spread/total is the CURRENT line, not the close; history can't test intermediate moves.
- Next: (a) once pack.closing() has rows, check whether open->current moves keep moving to close (that is CLV; different question from post-close); (b) spread vs moneyline disagreement (ML-implied margin minus spread) as a signal, CBB/NBA have ML closes; (c) key-number effects (NBA/CBB spreads crossing 3/7 less relevant; check totals).

## Starting point
- Starter model published as v1. It is a recency-weighted offence/defence ridge on ESPN results - nothing clever. Replace it with something that beats Elo and the ridge in the backtest.
