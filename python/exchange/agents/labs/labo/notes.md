# Open Lab lab notebook (anything goes)

Terse log, newest first: date, hypothesis, result with numbers, decision, next idea. Read it at the start of every session; it is your only memory.

## 2026-11-01 23:50 - v5 published: NHL total from Kalshi's ladder
- Report (v4): equity 10387, CLV +2.08c / 2331 sides. vs DK close per 1000 (live_split.py, after v4 only): nhl -5.8 (54, z -1.5; ml -5.1, puck -8.9, total -3.6), nba -2.2 (60, z -1.8), cfb -1.1 (150), nfl +2.2 (36), cbb -9.1 (6). NBA loses ~1c on ml/spread at ratings weight 0 -> engine spread->price conversion, not ratings (labm sees the same). live_gap.py: NHL |price-DK| ~3c = the 0.2/0.4 ratings weights.
- Hypothesis: live dk has no over/under juice; dk["kalshi"] ladder (P(total>L) at 3.5..8.5, with volume) supplies it. kalshi_ladder.py on pack.closing nhl (29 games, 19 with >=2 usable total rungs; Kalshi snapshot is the engine's pre-game views.kal, Kalshi syndicate scores = DK so no in-play leak).
- Poisson -LL of actual total: DK coin flip 2.3959, Kalshi-ladder mean 2.3454 (gain +0.050 se 0.027; halves +0.063/+0.039), v4 blend 2.3925 (+0.003). Brier over at DK line .2500/.2396/.2513. Monotone in weight a (0.5 +.028, 0.75 +.040, 1.0 +.050); ratings b=0.15 on top adds nothing.
- Other sports: Kalshi ladder median vs DK total MAE nba 17.39 vs 17.31 (n 21), cfb 10.39 vs 10.25 (n 48): nothing. NHL margin from Kalshi spread ladder: ml Brier .1992 vs DK-ML .2031 vs v4 .2085 (n 10) - too few.
- v5: NHL total = dk + 0.75 (kalshi - dk) when ladder exists; else ratings total weight 0.4 -> 0.15. Other sports unchanged (smoke_v5.py: only 29 NHL games change). Lineless backtest unchanged. Audit passed, published v5; model_v4.py kept as fallback.
- Honest read: ~1.9 se on 19 games; the mechanism (missing juice) is the same one the 2026-10-30 study found, which is why it shipped. Recheck at ~60 ladder games.
- Next: (a) NHL margin: Kalshi spread ladder + DK ML, and whether the 0.2 ratings margin weight should go (live ml/puck negative; n 10 ladders today); (b) the NBA ~1c ml/spread conversion gap: compare the engine's spread->ML map with DK's ML on pack.closing nba (could use ML-implied margin instead of -spread).

## 2026-10-30 01:30 - v4 published (= the v2 design below, restored). Two runs of this task overlapped.
- The "earlier session" mentioned below was this run (started 2026-10-29 09:41, same study, same blend_rows). Its splice published v3: logit NHL margin (1.3*logit p, first-half fit 1.29) and weights cbb .03/.10, nba .03/.03, nhl .10/.50, nfl/cfb .10/.10. Same conclusion; v2's engine-consistent NHL conversion is better, so v4 restores it exactly (v3 lived ~5 min).
- Extra numbers from this run (MAE/RMSE on blend_rows, margin): cbb v1 9.224/11.656 -> v2-style 8.804/11.087 (DK alone 8.802/11.081); nba 11.254/14.381 -> 11.175/14.265; nhl RMSE 2.676 -> 2.569. Slope of (result-DK) on (ratings-DK) by |diff| tercile: cbb big tercile -0.011 +- 0.021, so DK wins even when ratings disagree a lot. NHL total: with juice in a regression the ratings coef falls 0.58 -> 0.15 +- 0.22 (juice coef 6.9 +- 2.6).
- Scripts from this run: blend_eval.py, compare.py, nhl_study.py, smoke.py. model_raw.py feeds blend_study (raw ratings, dk stripped).
- Process: check notes.md AND the folder's file mtimes at session start; if another run is active (files touched within the last hour), report only.

## 2026-10-30 - v2 published: how much should ratings move DK, by sport? (+ NHL puck-line bug)
- Data: blend_rows.pkl = walk-forward v1 ratings (no lines) joined to DK closes: cbb n 4488 (2025-12..2026-04), nba n 1101, nhl n 1162. Scripts: blend_study.py, blend_eval.py, bb_blend_sq.py, nhl_market.py, nhl_juice.py. (An earlier session built blend_rows but left no notes.)
- BUG in v1: NHL `dk.spread` is the +-1.5 puck line; v1 used -spread as the margin -> |margin| 1.0 vs ML-implied 0.52. Home-win log loss v1 0.7093 vs ML-implied 0.6802 (huge). Live edge score -0.103 on 33 NHL lines fits this.
- Margin MSE vs ratings weight w (0 / 0.1 / 0.4): cbb 122.8 / 123.8 / 135.9; nba 203.4 / 203.7 / 206.8. Total: cbb 282.7 / 282.35 / 283.9 (OLS slope +0.13 se 0.05, both halves gain at 0.1); nba 333.2 / 333.3 / 338.1. => ratings add ~nothing to basketball lines.
- NHL: ML-implied margin + 0.2 ratings 0.6795 (noise-level gain). Total as Poisson mean with P(over)=0.5: -LL 2.2525 vs line-as-mean 2.2554; +0.4 ratings 2.2490 (both halves). With over/under juice the market alone gets 2.2465 and best ratings w ~0.15 -> ratings mostly proxy the juice that live `dk` lacks.
- v2: market converted to engine terms + W (margin,total): nba 0/0, cbb 0/0.1, nhl 0.2/0.4, nfl/cfb 0/0 (no line history). Lineless backtest unchanged (same ratings). Audit passed, published v2.
- Honest read: this mostly removes harm; the only real-looking signal is cbb totals and NHL totals (latter likely juice). Model now ~= DK in nba/nfl/cfb.
- Next: (a) Kalshi ladder (dk["kalshi"]) as the missing juice: fit a mean from Kalshi's total/spread ladder mids and test vs DK once pack.closing() has ~100+ rows (17 today); (b) NBA/CBB moneyline-vs-spread disagreement (ML-implied margin minus spread) - check it does not duplicate labm's next idea; (c) a better ratings source (box-score efficiency / player-based CBB ratings_v2) to see if any rating earns w>0 on cbb/nba margins.

## Starting point
- Starter model published as v1. It is a recency-weighted offence/defence ridge on ESPN results - nothing clever. Replace it with something that beats Elo and the ridge in the backtest.
