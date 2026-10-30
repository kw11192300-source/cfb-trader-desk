# Maker Lab notebook (labk)

Newest first. This file is the lab's only memory between sessions.

## 2026-10-30 - size of the sharp lean (published v2)
Live before: labk 47 fills, spread captured -1.14c, fill CLV +0.00c (mmt +0.27c/-0.25c, mmc +0.61c/-0.45c). Hit by other 72%, public 17%, sharp 11%.
Data: 944 trades, 811 settled, only 17 games, all within ~20 h (2026-10-29/30). No public takers in the settled history. Takers trade on average 0.8c better than DK fair (so fills need tight or leaned quotes).
Hypothesis: fit the lean per sharp-weighted contract. Drift (close - ref) vs sharp_net: slope 0.19c/contract in first 55% of trades, 0.055c in later blocks (saturates as positions build); corr stays positive (0.14-0.34),
but a lean fitted on the earlier half lowers out-of-sample drift MSE in every cap/shrink tried (-8% to -25%).
Replay sweep (lean multiplier on fitted tanh lean, 1.3c base): x0 edge +1.76c / vs close +2.48c / +44.7c per contract / 891 contr; x0.5 +1.44/+1.75/+38.0/697; x1 +0.84/+1.08/+22.4/1010; x2 +0.24/+0.34/+20.5/1129.
v1 (0.15c/contract cap 3c): +1.03/+1.31/+25.0/862. Baselines: tight 1.0c +1.30/+1.85/+35.4/1244; careful 1.7c +1.95/+1.95/+47.6/512.
No-lean base half 1.0c: +1.29/+1.81/+31.6/1307; 0.85c +1.23/+1.84/+31.1/1389; 1.7c +1.86/+1.92/+48.0/713. Sharp-side widening 0 / 0.004 / 0.008: no change in replay fills.
Decision: published v2 = fit() fits lean = A*tanh(sn/S), keeps it only if it beats no lean on a 60/40 time holdout (currently fails, lean 0), so quotes centre on DK; kept sharp-side widening, smaller size, lower inv_scale.
Best vs-close of any policy; ~72% of tight's volume. Within noise on 17 games, but monotone across lean sizes and consistent with the live -1.14c spread captured.
Caveat: the mandate says lean toward sharps; the data says the mid-lean is paid for in spread and not repaid by the close yet. The gate re-enables it automatically if the evidence appears.
Next: check the live scorecard for v2 (spread captured should turn positive). Then try width by hours to kickoff / sport (NHL 480 of 811 trades; prem is ~0 under 3 h vs ~-1c 3-48 h, so tighten near kickoff?), or test lower inv_scale only under strong sharp pressure (not testable in replay; use live).

## Start (baseline, written by the builder, not by a session)
Policy v1: base half-spread 1.3 cents, a little wider far from kickoff and tighter near it. Leans both quotes toward where sharp-weighted pressure is (1/10 cent per sharp-weighted contract, capped at 3 cents)
so the lab builds a position on the sharp side, charges more on the side sharp accounts hit, and is tighter and larger on the side public money hits. Pulls quotes on far lines more than a day out.
Nothing tuned yet. First job: run the replay (`python -m exchange.agents backtest exchange/agents/labs/labk/model.py`) and see whether it beats the fixed 1.0 / 1.7 / 3.0 cent baselines on profit per contract and on moves to the close.
