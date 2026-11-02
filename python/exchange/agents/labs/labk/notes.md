# Maker Lab notebook (labk)

Newest first. This file is the lab's only memory between sessions.

## 2026-11-01 - half-spread by sport x hours to kickoff x kind (not published; v2 stays live)
Live v2: labk 5071 fills, spread captured -0.26c, fill CLV +0.12c, maker P&L +749 (mmc -0.74c/-0.38c/-419, mmt +0.40c/+0.25c/-325). Hit by public 39%, sharp 22%, other 40%.
Engine rules checked (engine.py, as of 2026-11-01): policy half_bid/half_ask REPLACE the engine half, so the engine's own toxicity widening (tmult, tox) and NEAR_WIDEN (now 1.0) do not apply to us;
shift clipped to LEAN_CAP 3c; quote centre is the maker's model fair (clipped to ref +- BAND) minus inventory lean, NOT DraftKings, and the policy cannot see that fair (likely why live spread captured < replay);
wings >24h out are skipped by the engine anyway; inventory lean capped at 3c, past it the heavy side stops (main lines keep both sides); main-line size floor 10 (25 inside 3h).
Data: 21,350 settled trades, 119 games (was 811/17). Taker paid vs DK / close drift their way: public +1.06c / +0.01c (flat at every hours bucket: pure spread to earn); sharp -2.80c / +0.40c; other -0.78c / -0.42c.
Sharps mostly hit quotes sitting off DK; the close only runs 0.4c their way. But in replay the few sharp fills we take lose -8 to -13c vs close (2-4% of contracts): a small fat tail.
Hypothesis: learn half per (sport, hrs bucket <3/3-6/6-24/24-48/48+, kind) from grid 0.6-3.0c, maximising markout to close per opportunity, shrunk to parent cell (K=300).
Result, strict walk-forward 4 non-overlapping time blocks: live v2 34.0k contr, edge +1.50c, vs close +0.89c, pnl +3.87c/contr; width table 40.8k, +1.40c, +0.92c, +3.20c.
Variants (K=1000; grid floor 1.0c; floor 1.3c): vs close +0.90/+0.91/+0.90 every time; only edge vs volume trades off. backtest cmd: v2 +1.47/+0.77/+2.58 on 36.2k; table +1.36/+0.88/+1.89 on 43.3k; tight 1.0c +1.35/+0.69/+1.75 on 49.3k.
Decision: not published. Width by sport/hours does not separate adverse selection (markout flat ~0.9c/contract); +20% volume at -0.1c edge is not a genuine per-contract win. pnl/contr SE ~0.8c pooled, all within noise.
Next: attack the sharp fat tail. Find what precedes the -8 to -13c sharp fills (big |eco - ref| gap, large `flow`, sharp_n jump, sport/kind) and widen or pull only there; the replay has eco/flow as None/0, so first rebuild them from earlier trades in a helper.

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
